from fastapi import FastAPI, HTTPException, Depends, Request, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional, List
import jwt
import bcrypt
import os
import re
import httpx
import json
import asyncio
import tempfile
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False

try:
    import essentia.standard as es
    ESSENTIA_AVAILABLE = True
except ImportError:
    ESSENTIA_AVAILABLE = False

app = FastAPI()

# ─────────────────────────────────────────────────────────────
# CORS
#
# FIX: The /stream endpoint is loaded by <audio src=...> with
# crossorigin="anonymous". This triggers a CORS preflight.
# We must return Access-Control-Allow-Origin: * on BOTH the
# OPTIONS preflight AND the actual streaming response.
#
# The middleware below handles all routes including /stream.
# Additionally, the StreamingResponse inside /stream explicitly
# sets the header to guarantee it survives FastAPI's response pipeline.
# ─────────────────────────────────────────────────────────────
CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    # Required for streaming responses with CORS:
    "Access-Control-Expose-Headers": "Content-Length, Content-Type",
}

@app.middleware("http")
async def add_cors(request: Request, call_next):
    if request.method == "OPTIONS":
        return JSONResponse(status_code=204, headers=CORS_HEADERS)
    try:
        response = await call_next(request)
    except Exception as exc:
        response = JSONResponse(status_code=500, content={"detail": str(exc)})
    for k, v in CORS_HEADERS.items():
        response.headers[k] = v
    return response

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────
JWT_SECRET   = os.getenv("JWT_SECRET", "change-me-in-production")
DATABASE_URL = os.getenv("DATABASE_URL")
LASTFM_KEY   = os.getenv("LASTFM_API_KEY")
LASTFM_BASE  = "https://ws.audioscrobbler.com/2.0/"

_analysis_cache: dict = {}

security = HTTPBearer()

# ─────────────────────────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────────────────────────
class UserSignup(BaseModel):
    email: EmailStr
    username: str
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class SongData(BaseModel):
    song_name: str
    artist_name: str
    youtube_url: str

# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────
def extract_youtube_id(url: str) -> Optional[str]:
    for pattern in [
        r'(?:v=|\/)([0-9A-Za-z_-]{11})',
        r'(?:embed\/)([0-9A-Za-z_-]{11})',
        r'(?:youtu\.be\/)([0-9A-Za-z_-]{11})',
        r'(?:shorts\/)([0-9A-Za-z_-]{11})',
    ]:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return None

def get_db():
    if not PSYCOPG2_AVAILABLE:
        raise HTTPException(503, "psycopg2 not installed")
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not set")
    try:
        return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    except Exception as e:
        raise HTTPException(503, "Database temporarily unavailable")

def make_token(user_id: int, email: str) -> str:
    return jwt.encode(
        {"user_id": user_id, "email": email, "exp": datetime.utcnow() + timedelta(days=7)},
        JWT_SECRET, algorithm="HS256"
    )

def auth(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

# ─────────────────────────────────────────────────────────────
# AUDIO ANALYSIS — Essentia + yt-dlp pipeline
# ─────────────────────────────────────────────────────────────

def _download_audio(youtube_id: str, out_path: str) -> bool:
    """Download audio from YouTube using yt-dlp, convert to 22050Hz mono WAV."""
    try:
        cmd = [
            "yt-dlp",
            f"https://www.youtube.com/watch?v={youtube_id}",
            "--extract-audio",
            "--audio-format", "wav",
            "--audio-quality", "5",
            "--postprocessor-args", "-ar 22050 -ac 1",
            "--output", out_path,
            "--no-playlist",
            "--quiet",
            "--max-filesize", "50m",
        ]
        result = subprocess.run(cmd, timeout=90, capture_output=True, text=True)
        return result.returncode == 0 and Path(out_path).exists()
    except Exception as e:
        print(f"[yt-dlp] error: {e}")
        return False


def _analyze_with_essentia(wav_path: str) -> dict:
    if not ESSENTIA_AVAILABLE or not NUMPY_AVAILABLE:
        raise RuntimeError("Essentia or NumPy not installed")

    loader = es.MonoLoader(filename=wav_path, sampleRate=22050)
    audio  = loader()
    sr     = 22050

    rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
    bpm, beats, beats_confidence, _, beats_intervals = rhythm_extractor(audio)

    frame_size = 1024
    hop_size   = int(sr / 60)

    w         = es.Windowing(type='hann')
    spectrum  = es.Spectrum()
    centroid  = es.SpectralCentroidNormalized()
    mel_bands = es.MelBands(numberBands=8, sampleRate=sr, lowFrequencyBound=20, highFrequencyBound=8000)
    loudness  = es.Loudness()

    loudness_frames  = []
    centroid_frames  = []
    melband_frames   = []
    bass_frames      = []

    for i, frame in enumerate(es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size)):
        t = i * hop_size / sr

        loud_db   = float(loudness(frame))
        loud_norm = float(np.tanh(max(0.0, (loud_db + 60) / 60)))

        spec      = spectrum(w(frame))
        cent_norm = float(centroid(spec))

        mels = mel_bands(spec)
        mels_norm = [float(np.tanh(max(0.0, (v + 80) / 80))) for v in mels]

        bass_energy = float(np.mean(mels_norm[:2]))

        loudness_frames.append( {"t": round(t, 4), "v": round(loud_norm,  4)} )
        centroid_frames.append( {"t": round(t, 4), "c": round(cent_norm,  4)} )
        melband_frames.append(  {"t": round(t, 4), "bands": [round(m, 4) for m in mels_norm]} )
        bass_frames.append(     {"t": round(t, 4), "b": round(bass_energy, 4)} )

    beat_list = [{"t": round(float(b), 4)} for b in beats]

    return {
        "tempo":    round(float(bpm), 2),
        "beats":    beat_list,
        "loudness": loudness_frames,
        "spectral": centroid_frames,
        "melbands": melband_frames,
        "bass":     bass_frames,
    }


def _fallback_analysis(duration_estimate: float = 240.0) -> dict:
    import math
    tempo  = 120.0
    beat_t = 60.0 / tempo
    beats  = [{"t": round(i * beat_t, 4)} for i in range(int(duration_estimate / beat_t))]

    loudness, spectral, melbands, bass = [], [], [], []
    for i in range(int(duration_estimate * 60)):
        t = i / 60.0
        v  = round(0.5 + 0.35 * math.sin(t * 0.8) + 0.15 * math.sin(t * 3.1), 4)
        c  = round(0.4 + 0.3  * math.sin(t * 0.5 + 1.2), 4)
        b  = round(0.3 + 0.25 * abs(math.sin(t * math.pi * 2.0)), 4)
        ms = [round(0.2 + 0.2 * math.sin(t * (0.4 + k * 0.15) + k), 4) for k in range(8)]

        loudness.append({"t": round(t, 4), "v": v})
        spectral.append({"t": round(t, 4), "c": c})
        bass.append(    {"t": round(t, 4), "b": b})
        melbands.append({"t": round(t, 4), "bands": ms})

    return {"tempo": tempo, "beats": beats, "loudness": loudness,
            "spectral": spectral, "melbands": melbands, "bass": bass}


# ─────────────────────────────────────────────────────────────
# STARTUP
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id               SERIAL PRIMARY KEY,
                email            VARCHAR(255) UNIQUE NOT NULL,
                username         VARCHAR(100) NOT NULL,
                password_hash    VARCHAR(255) NOT NULL,
                song_name        VARCHAR(255),
                artist_name      VARCHAR(255),
                youtube_url      TEXT,
                youtube_video_id VARCHAR(20),
                created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit(); cur.close(); conn.close()
        print("[startup] DB ready ✓")
    except Exception as e:
        print(f"[startup] DB init skipped: {e}")

# ─────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "message": "OneSong API", "version": "4.1.0-gpgpu",
            "essentia": ESSENTIA_AVAILABLE}

@app.get("/health")
def health():
    db_ok = False
    try:
        conn = get_db(); conn.close(); db_ok = True
    except Exception:
        pass
    return {
        "status":    "healthy" if db_ok else "degraded",
        "database":  "healthy" if db_ok else "unavailable",
        "essentia":  ESSENTIA_AVAILABLE,
        "numpy":     NUMPY_AVAILABLE,
        "timestamp": datetime.utcnow().isoformat(),
    }

@app.post("/auth/signup")
def signup(user: UserSignup):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT id FROM users WHERE email = %s", (user.email,))
        if cur.fetchone():
            raise HTTPException(400, "Email already registered")
        pw_hash = bcrypt.hashpw(user.password.encode(), bcrypt.gensalt()).decode()
        cur.execute(
            "INSERT INTO users (email, username, password_hash) VALUES (%s,%s,%s) RETURNING id",
            (user.email, user.username, pw_hash)
        )
        uid = cur.fetchone()["id"]; conn.commit()
    finally:
        cur.close(); conn.close()
    return {"token": make_token(uid, user.email),
            "user": {"id": uid, "email": user.email, "username": user.username}}

@app.post("/auth/login")
def login(user: UserLogin):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT id,email,username,password_hash FROM users WHERE email=%s", (user.email,))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row or not bcrypt.checkpw(user.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    return {"token": make_token(row["id"], row["email"]),
            "user": {"id": row["id"], "email": row["email"], "username": row["username"]}}

@app.get("/auth/verify")
def verify(payload: dict = Depends(auth)):
    return {"valid": True, "user_id": payload["user_id"]}

@app.get("/user/song")
def get_song(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT song_name,artist_name,youtube_url,youtube_video_id FROM users WHERE id=%s",
                    (payload["user_id"],))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row or not row["youtube_url"]:
        return {"has_song": False, "song": None}
    return {"has_song": True, "song": dict(row)}

@app.put("/user/song")
def save_song(song: SongData, payload: dict = Depends(auth)):
    vid = extract_youtube_id(song.youtube_url)
    if not vid:
        raise HTTPException(400, "Invalid YouTube URL")
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("""UPDATE users SET song_name=%s,artist_name=%s,youtube_url=%s,
               youtube_video_id=%s,updated_at=CURRENT_TIMESTAMP WHERE id=%s""",
               (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"]))
        conn.commit()
    finally:
        cur.close(); conn.close()
    return {"message": "Saved!", "song": {**song.dict(), "youtube_video_id": vid}}

@app.get("/recommendations")
async def recommendations(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        raise HTTPException(500, "Last.fm API key not configured")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(LASTFM_BASE, params={
            "method": "track.getSimilar", "track": track, "artist": artist,
            "api_key": LASTFM_KEY, "format": "json", "limit": "5", "autocorrect": "1",
        })
        raw = r.json().get("similartracks", {}).get("track", [])
        if not raw:
            s = await client.get(LASTFM_BASE, params={
                "method": "track.search", "track": track,
                "api_key": LASTFM_KEY, "format": "json", "limit": "1",
            })
            hits = s.json().get("results", {}).get("trackmatches", {}).get("track", [])
            if hits:
                found = hits[0] if isinstance(hits, list) else hits
                r2 = await client.get(LASTFM_BASE, params={
                    "method": "track.getSimilar", "track": found["name"],
                    "artist": found["artist"], "api_key": LASTFM_KEY,
                    "format": "json", "limit": "5", "autocorrect": "1",
                })
                raw = r2.json().get("similartracks", {}).get("track", [])
    return {"tracks": [
        {"name": t["name"], "artist": t["artist"]["name"],
         "match": round(float(t.get("match", 0)) * 100), "url": t.get("url", "")}
        for t in raw[:3]
    ]}

@app.get("/mood")
async def get_mood(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        raise HTTPException(500, "Last.fm API key not configured")
    tags = []
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(LASTFM_BASE, params={
            "method": "track.getTopTags", "track": track, "artist": artist,
            "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
        })
        raw = r.json().get("toptags", {}).get("tag", [])
        tags = [t["name"].lower() for t in raw if int(t.get("count", 0)) > 10]
        if len(tags) < 3:
            r2 = await client.get(LASTFM_BASE, params={
                "method": "artist.getTopTags", "artist": artist,
                "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
            })
            tags += [t["name"].lower() for t in r2.json().get("toptags", {}).get("tag", [])[:10]]
    return {"tags": tags[:20]}

@app.get("/audio_analysis")
async def audio_analysis(track: str, artist: str, payload: dict = Depends(auth)):
    cache_key = f"{track.lower().strip()}|{artist.lower().strip()}"

    if cache_key in _analysis_cache:
        return _analysis_cache[cache_key]

    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT youtube_video_id FROM users WHERE id=%s AND LOWER(song_name)=LOWER(%s)",
            (payload["user_id"], track)
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()

    youtube_id = row["youtube_video_id"] if row else None

    if youtube_id and ESSENTIA_AVAILABLE and NUMPY_AVAILABLE:
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = os.path.join(tmp, "audio.wav")
            downloaded = await asyncio.get_event_loop().run_in_executor(
                None, _download_audio, youtube_id, wav_path
            )
            if downloaded:
                try:
                    result = await asyncio.get_event_loop().run_in_executor(
                        None, _analyze_with_essentia, wav_path
                    )
                    _analysis_cache[cache_key] = result
                    return result
                except Exception as e:
                    print(f"[analysis] Essentia failed: {e}")

    print(f"[analysis] Using synthetic fallback for '{track}' by '{artist}'")
    result = _fallback_analysis(duration_estimate=240.0)
    _analysis_cache[cache_key] = result
    return result


@app.get("/stream")
async def stream_audio(request: Request, youtube_id: str, token: str = None):
    """
    Headless audio streaming endpoint.

    FIX: This endpoint is called with crossorigin="anonymous" from <audio src>.
    The CORS middleware above sets Access-Control-Allow-Origin: * on the response.
    The StreamingResponse also explicitly includes the header for extra safety.

    Token is passed as query param because <audio src> cannot carry
    an Authorization header. This is validated before streaming begins.

    yt-dlp format priority:
      1. bestaudio[ext=webm]  → Opus in WebM — best browser support
      2. bestaudio[ext=m4a]   → AAC in MP4 — Safari fallback
      3. bestaudio            → whatever is available
    """
    from fastapi.responses import StreamingResponse
    import shutil

    # Validate JWT from query param
    if not token:
        raise HTTPException(401, "Token required")
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")

    if not re.match(r'^[a-zA-Z0-9_\-]{11}$', youtube_id):
        raise HTTPException(400, "Invalid youtube_id")

    if not shutil.which("yt-dlp"):
        # yt-dlp not installed — redirect to YouTube watch page
        from fastapi.responses import RedirectResponse
        return RedirectResponse(f"https://www.youtube.com/watch?v={youtube_id}")

    # yt-dlp command — pipe audio to stdout
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "--output", "-",
        "--quiet",
        "--no-warnings",
        "--no-cache-dir",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]

    async def audio_generator():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = await proc.stdout.read(65536)  # 64 KB chunks
                if not chunk:
                    break
                yield chunk
        except asyncio.CancelledError:
            # Client disconnected
            pass
        finally:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass

    # FIX: Explicit CORS headers on StreamingResponse.
    # The CORS middleware runs AFTER response creation, but StreamingResponse
    # headers are set at construction time. Belt-and-braces: set them here too.
    stream_headers = {
        "Cache-Control":                "no-cache, no-store",
        "Accept-Ranges":                "none",
        "X-Content-Type-Options":       "nosniff",
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }

    return StreamingResponse(
        audio_generator(),
        media_type="audio/webm",
        headers=stream_headers,
    )


@app.get("/user/profile")
def profile(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT id,email,username,created_at FROM users WHERE id=%s", (payload["user_id"],))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row:
        raise HTTPException(404, "User not found")
    return {**dict(row), "created_at": row["created_at"].isoformat() if row["created_at"] else None}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))