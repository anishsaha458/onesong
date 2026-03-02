"""
main.py — OneSong API  v4.5
────────────────────────────────────────────────────────────────
FIXES vs v4.4:

[D1] CORS middleware crash (JSONResponse 204 TypeError):
     JSONResponse(status_code=204) with no content arg raises TypeError
     in Starlette because a 204 response MUST have no body but JSONResponse
     always serialises content. FIX: return Response(status_code=204) for
     OPTIONS preflight — no content needed, just headers.

[D2] /stream now explicitly supports WAV MIME and serves from tmp correctly.
     _EXT_TO_MIME already had "wav": "audio/wav" but _YT_FORMAT did not
     include wav as a final fallback. Added wav fallback to _YT_FORMAT.
"""

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import jwt
import bcrypt
import os
import re
import httpx
import asyncio
import tempfile
import subprocess
import shutil
import math
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

app = FastAPI(title="OneSong API", version="4.5.0")

# ─────────────────────────────────────────────────────────────
# CORS
# FIX [D1]: OPTIONS preflight MUST use Response(status_code=204), NOT
# JSONResponse(status_code=204). JSONResponse always emits a body (even
# if it's just "null"), which violates RFC 7231 for 204 No Content and
# causes a TypeError in Starlette's response serialiser.
# ─────────────────────────────────────────────────────────────
CORS_HEADERS = {
    "Access-Control-Allow-Origin":   "*",
    "Access-Control-Allow-Methods":  "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":  "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Content-Length, Content-Type",
}

@app.middleware("http")
async def add_cors(request: Request, call_next):
    if request.method == "OPTIONS":
        # FIX [D1]: Response (not JSONResponse) — no body, correct 204
        return Response(status_code=204, headers=CORS_HEADERS)
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
# Format → MIME type map
# ─────────────────────────────────────────────────────────────
_EXT_TO_MIME: dict[str, str] = {
    "webm": "audio/webm",
    "m4a":  "audio/mp4",
    "mp4":  "audio/mp4",
    "aac":  "audio/aac",
    "mp3":  "audio/mpeg",
    "ogg":  "audio/ogg",
    "opus": "audio/ogg; codecs=opus",
    "wav":  "audio/wav",     # FIX [D2]: explicit WAV MIME support
}
_FALLBACK_MIME = "audio/webm"

# FIX [D2]: Added wav as final fallback in format chain
_YT_FORMAT = (
    "bestaudio[ext=webm]"
    "/bestaudio[ext=m4a]"
    "/bestaudio[ext=mp3]"
    "/bestaudio[ext=wav]"
    "/bestaudio"
    "/worst"
)

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
    except Exception:
        raise HTTPException(503, "Database temporarily unavailable")

def make_token(user_id: int, email: str) -> str:
    return jwt.encode(
        {"user_id": user_id, "email": email,
         "exp": datetime.utcnow() + timedelta(days=7)},
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
# Probe yt-dlp for actual MIME type before streaming
# ─────────────────────────────────────────────────────────────
async def _probe_stream_mime(youtube_id: str) -> str:
    if not shutil.which("yt-dlp"):
        return _FALLBACK_MIME
    cmd = [
        "yt-dlp", "--no-playlist", "--no-cache-dir",
        "--quiet", "--no-warnings",
        "--format", _YT_FORMAT,
        "--print", "%(ext)s",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        ext = stdout.decode().strip().lower()
        mime = _EXT_TO_MIME.get(ext, _FALLBACK_MIME)
        print(f"[probe] {youtube_id} → ext={ext!r} mime={mime!r}")
        return mime
    except Exception as e:
        print(f"[probe] failed for {youtube_id}: {e} — using {_FALLBACK_MIME}")
        return _FALLBACK_MIME

# ─────────────────────────────────────────────────────────────
# AUDIO ANALYSIS — Essentia + yt-dlp pipeline
# ─────────────────────────────────────────────────────────────

def _download_audio(youtube_id: str, out_path: str) -> bool:
    if not shutil.which("yt-dlp"):
        print("[yt-dlp] not in PATH")
        return False
    try:
        cmd = [
            "yt-dlp",
            f"https://www.youtube.com/watch?v={youtube_id}",
            "--extract-audio",
            "--audio-format", "wav",
            "--audio-quality", "5",
            "--postprocessor-args", "ffmpeg:-ar 22050 -ac 1",
            "--output", out_path,
            "--no-playlist",
            "--no-cache-dir",
            "--no-check-certificates",
            "--quiet",
            "--max-filesize", "50m",
        ]
        result = subprocess.run(cmd, timeout=120, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[yt-dlp] rc={result.returncode}: {result.stderr[:300]}")
        return result.returncode == 0 and Path(out_path).exists()
    except subprocess.TimeoutExpired:
        print("[yt-dlp] timeout 120s")
        return False
    except Exception as e:
        print(f"[yt-dlp] error: {e}")
        return False


def _analyze_with_essentia(wav_path: str) -> dict:
    if not ESSENTIA_AVAILABLE or not NUMPY_AVAILABLE:
        raise RuntimeError("Essentia or NumPy not available")

    wav_size_mb = Path(wav_path).stat().st_size / (1024 * 1024)
    if wav_size_mb > 45:
        raise RuntimeError(f"WAV too large ({wav_size_mb:.1f}MB > 45MB OOM guard) — using fallback")

    loader = es.MonoLoader(filename=wav_path, sampleRate=22050)
    audio  = loader()
    sr     = 22050

    rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
    bpm, beats, _, _, _ = rhythm_extractor(audio)

    frame_size = 1024
    hop_size   = int(sr / 60)

    w             = es.Windowing(type="hann")
    spectrum_algo = es.Spectrum()
    centroid_algo = es.SpectralCentroidNormalized()
    mel_bands_algo = es.MelBands(
        numberBands=8, sampleRate=sr,
        lowFrequencyBound=20, highFrequencyBound=8000
    )
    loudness_algo = es.Loudness()

    loudness_frames, centroid_frames, melband_frames, bass_frames = [], [], [], []

    for i, frame in enumerate(
        es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size)
    ):
        t         = i * hop_size / sr
        loud_db   = float(loudness_algo(frame))
        loud_norm = float(np.tanh(max(0.0, (loud_db + 60) / 60)))
        spec      = spectrum_algo(w(frame))
        cent_norm = float(centroid_algo(spec))
        mels      = mel_bands_algo(spec)
        mels_norm = [float(np.tanh(max(0.0, (v + 80) / 80))) for v in mels]
        bass_val  = float(np.mean(mels_norm[:2]))

        loudness_frames.append({"t": round(t, 4), "v": round(loud_norm, 4)})
        centroid_frames.append({"t": round(t, 4), "c": round(cent_norm, 4)})
        melband_frames.append( {"t": round(t, 4), "bands": [round(m, 4) for m in mels_norm]})
        bass_frames.append(    {"t": round(t, 4), "b": round(bass_val, 4)})

    return {
        "tempo":    round(float(bpm), 2),
        "beats":    [{"t": round(float(b), 4)} for b in beats],
        "loudness": loudness_frames,
        "spectral": centroid_frames,
        "melbands": melband_frames,
        "bass":     bass_frames,
    }


def _fallback_analysis(duration_estimate: float = 240.0) -> dict:
    tempo  = 120.0
    beat_t = 60.0 / tempo
    beats  = [{"t": round(i * beat_t, 4)}
              for i in range(int(duration_estimate / beat_t))]

    loudness_f, spectral_f, melbands_f, bass_f = [], [], [], []
    for i in range(int(duration_estimate * 60)):
        t  = i / 60.0
        v  = round(0.5 + 0.35 * math.sin(t * 0.8)  + 0.15 * math.sin(t * 3.1), 4)
        c  = round(0.4 + 0.3  * math.sin(t * 0.5  + 1.2), 4)
        b  = round(0.3 + 0.25 * abs(math.sin(t * math.pi * 2.0)), 4)
        ms = [round(0.2 + 0.2 * math.sin(t * (0.4 + k * 0.15) + k), 4) for k in range(8)]
        loudness_f.append({"t": round(t, 4), "v": v})
        spectral_f.append({"t": round(t, 4), "c": c})
        bass_f.append(    {"t": round(t, 4), "b": b})
        melbands_f.append({"t": round(t, 4), "bands": ms})

    return {
        "tempo": tempo, "beats": beats,
        "loudness": loudness_f, "spectral": spectral_f,
        "melbands": melbands_f, "bass": bass_f,
    }

# ─────────────────────────────────────────────────────────────
# STARTUP
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    print("=" * 55)
    print("  OneSong API v4.5 — startup")
    print("=" * 55)
    print(f"  ffmpeg:    {shutil.which('ffmpeg') or 'NOT IN PATH ← stream will fail'}")
    print(f"  yt-dlp:    {shutil.which('yt-dlp') or 'NOT IN PATH ← stream will fail'}")
    print(f"  essentia:  {ESSENTIA_AVAILABLE}")
    print(f"  numpy:     {NUMPY_AVAILABLE}")
    print(f"  psycopg2:  {PSYCOPG2_AVAILABLE}")
    print(f"  db url:    {'set' if DATABASE_URL else 'NOT SET — DB routes will 503'}")
    print(f"  jwt:       {'CUSTOM ✓' if JWT_SECRET != 'change-me-in-production' else 'DEFAULT — set JWT_SECRET!'}")
    print("=" * 55)

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
        conn.commit()
        cur.close()
        conn.close()
        print("[startup] DB schema OK ✓")
    except Exception as e:
        print(f"[startup] DB init skipped (non-fatal): {e}")

# ─────────────────────────────────────────────────────────────
# ROUTES — root / health / diag
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {
        "status":   "ok",
        "message":  "OneSong API",
        "version":  "4.5.0",
        "essentia": ESSENTIA_AVAILABLE,
        "yt_dlp":   shutil.which("yt-dlp") is not None,
        "ffmpeg":   shutil.which("ffmpeg") is not None,
    }

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
        "yt_dlp":    shutil.which("yt-dlp") is not None,
        "ffmpeg":    shutil.which("ffmpeg") is not None,
        "timestamp": datetime.utcnow().isoformat(),
    }

@app.get("/diag")
def diag():
    db_ok, db_err = False, ""
    try:
        c = get_db(); c.close(); db_ok = True
    except Exception as e:
        db_err = str(e)
    return {
        "status": "ok", "version": "4.5.0",
        "routes": [
            "GET /", "GET /health", "GET /diag",
            "POST /auth/signup", "POST /auth/login", "GET /auth/verify",
            "GET /user/song", "PUT /user/song", "GET /user/profile",
            "GET /mood", "GET /recommendations",
            "GET /audio_analysis", "GET /stream",
        ],
        "deps": {
            "psycopg2": PSYCOPG2_AVAILABLE,
            "numpy":    NUMPY_AVAILABLE,
            "essentia": ESSENTIA_AVAILABLE,
            "yt_dlp":   shutil.which("yt-dlp"),
            "ffmpeg":   shutil.which("ffmpeg"),
        },
        "env": {
            "DATABASE_URL":   "set" if DATABASE_URL else "NOT SET",
            "JWT_SECRET":     "custom" if JWT_SECRET != "change-me-in-production" else "DEFAULT — CHANGE THIS",
            "LASTFM_API_KEY": "set" if LASTFM_KEY else "not set",
        },
        "database": {"ok": db_ok, "error": db_err},
        "ts": datetime.utcnow().isoformat() + "Z",
    }

# ─────────────────────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────────────────────
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
        uid = cur.fetchone()["id"]
        conn.commit()
    finally:
        cur.close(); conn.close()
    return {
        "token": make_token(uid, user.email),
        "user":  {"id": uid, "email": user.email, "username": user.username},
    }

@app.post("/auth/login")
def login(user: UserLogin):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id,email,username,password_hash FROM users WHERE email=%s",
            (user.email,)
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row or not bcrypt.checkpw(user.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    return {
        "token": make_token(row["id"], row["email"]),
        "user":  {"id": row["id"], "email": row["email"], "username": row["username"]},
    }

@app.get("/auth/verify")
def verify(payload: dict = Depends(auth)):
    return {"valid": True, "user_id": payload["user_id"]}

# ─────────────────────────────────────────────────────────────
# USER SONG
# ─────────────────────────────────────────────────────────────
@app.get("/user/song")
def get_song(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT song_name,artist_name,youtube_url,youtube_video_id FROM users WHERE id=%s",
            (payload["user_id"],)
        )
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
        cur.execute(
            """UPDATE users SET song_name=%s, artist_name=%s, youtube_url=%s,
               youtube_video_id=%s, updated_at=CURRENT_TIMESTAMP WHERE id=%s""",
            (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"])
        )
        conn.commit()
    finally:
        cur.close(); conn.close()
    song_dict = song.model_dump() if hasattr(song, "model_dump") else song.dict()
    return {"message": "Saved!", "song": {**song_dict, "youtube_video_id": vid}}

@app.get("/user/profile")
def profile(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id,email,username,created_at FROM users WHERE id=%s",
            (payload["user_id"],)
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row:
        raise HTTPException(404, "User not found")
    return {
        **dict(row),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }

# ─────────────────────────────────────────────────────────────
# LAST.FM
# ─────────────────────────────────────────────────────────────
@app.get("/mood")
async def get_mood(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        return {"tags": []}
    tags = []
    try:
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
                tags += [t["name"].lower()
                         for t in r2.json().get("toptags", {}).get("tag", [])[:10]]
    except Exception as e:
        print(f"[mood] Last.fm failed: {e}")
    return {"tags": tags[:20]}

@app.get("/recommendations")
async def recommendations(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        return {"tracks": []}
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

# ─────────────────────────────────────────────────────────────
# AUDIO ANALYSIS
# ─────────────────────────────────────────────────────────────
@app.get("/audio_analysis")
async def audio_analysis(
    track: str,
    artist: str,
    payload: dict = Depends(auth),
    youtube_id: Optional[str] = None,
):
    vid = youtube_id
    if not vid:
        try:
            conn = get_db(); cur = conn.cursor()
            try:
                cur.execute(
                    "SELECT youtube_video_id FROM users WHERE id=%s",
                    (payload["user_id"],)
                )
                row = cur.fetchone()
                if row:
                    vid = row["youtube_video_id"]
            finally:
                cur.close(); conn.close()
        except Exception as e:
            print(f"[audio_analysis] DB lookup failed: {e}")

    if not vid:
        print(f"[audio_analysis] No youtube_id for '{track}' — synthetic fallback")
        return _fallback_analysis()

    if vid in _analysis_cache:
        print(f"[audio_analysis] Cache hit: {vid}")
        return _analysis_cache[vid]

    loop = asyncio.get_running_loop()

    if ESSENTIA_AVAILABLE and NUMPY_AVAILABLE and shutil.which("yt-dlp"):
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = os.path.join(tmp, f"{vid}.wav")
            print(f"[audio_analysis] Downloading {vid}…")
            downloaded = await loop.run_in_executor(None, _download_audio, vid, wav_path)
            if downloaded:
                print(f"[audio_analysis] Running Essentia…")
                try:
                    result = await loop.run_in_executor(None, _analyze_with_essentia, wav_path)
                    _analysis_cache[vid] = result
                    print(f"[audio_analysis] Essentia OK: {result['tempo']:.1f} BPM")
                    return result
                except Exception as e:
                    print(f"[audio_analysis] Essentia failed: {e}")
            else:
                print(f"[audio_analysis] Download failed for {vid}")
    else:
        missing = [
            x for x, ok in [
                ("essentia", ESSENTIA_AVAILABLE),
                ("numpy", NUMPY_AVAILABLE),
                ("yt-dlp", bool(shutil.which("yt-dlp"))),
            ] if not ok
        ]
        print(f"[audio_analysis] Missing: {missing} — synthetic fallback")

    result = _fallback_analysis()
    _analysis_cache[vid] = result
    return result

# ─────────────────────────────────────────────────────────────
# AUDIO STREAM
# FIX [D2]: WAV MIME type now correctly negotiated via probe
# ─────────────────────────────────────────────────────────────
@app.get("/stream")
async def stream_audio(
    request: Request,
    youtube_id: str,
    token: Optional[str] = None,
):
    if not token:
        raise HTTPException(401, "Token required")
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(401, "Invalid token")

    if not re.match(r'^[a-zA-Z0-9_\-]{11}$', youtube_id):
        raise HTTPException(400, "Invalid youtube_id format")

    if not shutil.which("yt-dlp"):
        print(f"[stream] yt-dlp not found — redirecting to YouTube")
        return RedirectResponse(
            f"https://www.youtube.com/watch?v={youtube_id}", status_code=302
        )

    mime = await _probe_stream_mime(youtube_id)

    cmd = [
        "yt-dlp",
        "--no-playlist", "--no-cache-dir",
        "--quiet", "--no-warnings",
        "--no-check-certificates",
        "--format", _YT_FORMAT,
        "--output", "-",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]

    print(f"[stream] Starting stream: {youtube_id}  mime={mime}")

    _FIRST_CHUNK_TIMEOUT = 12.0

    async def audio_generator():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        bytes_sent = 0
        try:
            try:
                first_chunk = await asyncio.wait_for(
                    proc.stdout.read(65536),
                    timeout=_FIRST_CHUNK_TIMEOUT
                )
            except asyncio.TimeoutError:
                stderr_bytes = b""
                try:
                    stderr_bytes = await asyncio.wait_for(proc.stderr.read(512), timeout=1.0)
                except Exception:
                    pass
                print(f"[stream] First-chunk timeout for {youtube_id}. stderr: {stderr_bytes.decode()[:200]}")
                return

            if not first_chunk:
                stderr_bytes = b""
                try:
                    stderr_bytes = await asyncio.wait_for(proc.stderr.read(512), timeout=1.0)
                except Exception:
                    pass
                print(f"[stream] yt-dlp exited immediately for {youtube_id}. stderr: {stderr_bytes.decode()[:200]}")
                return

            bytes_sent += len(first_chunk)
            yield first_chunk

            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                bytes_sent += len(chunk)
                yield chunk

        except asyncio.CancelledError:
            pass
        finally:
            print(f"[stream] {youtube_id}: sent {bytes_sent // 1024}KB")
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass

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
        media_type=mime,
        headers=stream_headers,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        log_level="info",
    )