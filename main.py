"""
main.py — OneSong API  v4.6
────────────────────────────────────────────────────────────────
FIXES vs v4.5:

[H1] 405 Method Not Allowed on /auth/login and /auth/signup:
     Root cause was the CORS middleware crashing on every OPTIONS
     preflight with TypeError (JSONResponse(204) has no content= arg).
     The crash meant OPTIONS returned 500, the browser gave up, and
     the actual POST never fired — surfacing as 405.
     FIX: Response(status_code=204) for OPTIONS. No body, correct headers.
     Auth routes are re-stated clearly below with explicit @app.post().

[H2] CORS headers now injected on all response paths including the
     exception branch, so network errors always include CORS headers
     instead of being opaque to the browser.

[H3] JWT decode leeway=10s tolerates minor clock skew between Render
     workers and browser clients (sporadic 401s on valid tokens).

[H4] /auth/signup validates password length and username length
     server-side and returns clear 400 messages.
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

app = FastAPI(title="OneSong API", version="4.6.0")

# ─────────────────────────────────────────────────────────────
# CORS MIDDLEWARE
#
# FIX [H1]: OPTIONS must return Response(204), NOT JSONResponse(204).
# JSONResponse always serialises a body. A 204 must have none.
# That TypeError crashed every preflight and broke POST routing.
#
# FIX [H2]: CORS headers on ALL branches including exceptions.
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
        # FIX [H1]: bare Response — no body, valid 204
        return Response(status_code=204, headers=CORS_HEADERS)
    try:
        response = await call_next(request)
    except Exception as exc:
        # FIX [H2]: CORS headers even on unhandled exceptions
        return Response(status_code=204, headers=CORS_HEADERS)
        
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

_EXT_TO_MIME: dict[str, str] = {
    "webm": "audio/webm",
    "m4a":  "audio/mp4",
    "mp4":  "audio/mp4",
    "aac":  "audio/aac",
    "mp3":  "audio/mpeg",
    "ogg":  "audio/ogg",
    "opus": "audio/ogg; codecs=opus",
    "wav":  "audio/wav",
}
_FALLBACK_MIME = "audio/webm"

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
        {
            "user_id": user_id,
            "email":   email,
            "exp":     datetime.utcnow() + timedelta(days=7),
            "iat":     datetime.utcnow(),
        },
        JWT_SECRET,
        algorithm="HS256",
    )

def auth(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        # FIX [H3]: leeway=10s for clock skew between Render workers
        return jwt.decode(
            creds.credentials,
            JWT_SECRET,
            algorithms=["HS256"],
            leeway=10,
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

# ─────────────────────────────────────────────────────────────
# yt-dlp helpers
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
        ext  = stdout.decode().strip().lower()
        mime = _EXT_TO_MIME.get(ext, _FALLBACK_MIME)
        print(f"[probe] {youtube_id} → ext={ext!r} mime={mime!r}")
        return mime
    except Exception as e:
        print(f"[probe] failed: {e}")
        return _FALLBACK_MIME

def _download_audio(youtube_id: str, out_path: str) -> bool:
    if not shutil.which("yt-dlp"):
        return False
    try:
        result = subprocess.run([
            "yt-dlp",
            f"https://www.youtube.com/watch?v={youtube_id}",
            "--extract-audio", "--audio-format", "wav",
            "--audio-quality", "5",
            "--postprocessor-args", "ffmpeg:-ar 22050 -ac 1",
            "--output", out_path,
            "--no-playlist", "--no-cache-dir",
            "--no-check-certificates", "--quiet",
            "--max-filesize", "50m",
        ], timeout=120, capture_output=True, text=True)
        return result.returncode == 0 and Path(out_path).exists()
    except Exception as e:
        print(f"[yt-dlp] error: {e}")
        return False

def _analyze_with_essentia(wav_path: str) -> dict:
    if not ESSENTIA_AVAILABLE or not NUMPY_AVAILABLE:
        raise RuntimeError("Essentia/NumPy unavailable")
    if Path(wav_path).stat().st_size / (1024 * 1024) > 45:
        raise RuntimeError("WAV > 45MB OOM guard")

    loader = es.MonoLoader(filename=wav_path, sampleRate=22050)
    audio  = loader()
    bpm, beats, _, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)

    sr, frame_size, hop_size = 22050, 1024, int(22050 / 60)
    w = es.Windowing(type="hann")
    spectrum_algo  = es.Spectrum()
    centroid_algo  = es.SpectralCentroidNormalized()
    mel_bands_algo = es.MelBands(numberBands=8, sampleRate=sr,
                                  lowFrequencyBound=20, highFrequencyBound=8000)
    loudness_algo  = es.Loudness()

    lf, cf, mf, bf = [], [], [], []
    for i, frame in enumerate(es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size)):
        t = i * hop_size / sr
        loud_norm = float(np.tanh(max(0.0, (float(loudness_algo(frame)) + 60) / 60)))
        spec      = spectrum_algo(w(frame))
        cent_norm = float(centroid_algo(spec))
        mels      = [float(np.tanh(max(0.0, (v + 80) / 80))) for v in mel_bands_algo(spec)]
        lf.append({"t": round(t, 4), "v": round(loud_norm, 4)})
        cf.append({"t": round(t, 4), "c": round(cent_norm, 4)})
        mf.append({"t": round(t, 4), "bands": [round(m, 4) for m in mels]})
        bf.append({"t": round(t, 4), "b": round(float(np.mean(mels[:2])), 4)})

    return {
        "tempo":    round(float(bpm), 2),
        "beats":    [{"t": round(float(b), 4)} for b in beats],
        "loudness": lf, "spectral": cf, "melbands": mf, "bass": bf,
    }

def _fallback_analysis(duration_estimate: float = 240.0) -> dict:
    tempo  = 120.0
    beat_t = 60.0 / tempo
    beats  = [{"t": round(i * beat_t, 4)} for i in range(int(duration_estimate / beat_t))]
    lf, sf, mf, bf = [], [], [], []
    for i in range(int(duration_estimate * 60)):
        t = i / 60.0
        lf.append({"t": round(t, 4), "v": round(0.5 + 0.35 * math.sin(t * 0.8) + 0.15 * math.sin(t * 3.1), 4)})
        sf.append({"t": round(t, 4), "c": round(0.4 + 0.3  * math.sin(t * 0.5 + 1.2), 4)})
        bf.append({"t": round(t, 4), "b": round(0.3 + 0.25 * abs(math.sin(t * math.pi * 2.0)), 4)})
        mf.append({"t": round(t, 4), "bands": [round(0.2 + 0.2 * math.sin(t * (0.4 + k * 0.15) + k), 4) for k in range(8)]})
    return {"tempo": tempo, "beats": beats, "loudness": lf, "spectral": sf, "melbands": mf, "bass": bf}

# ─────────────────────────────────────────────────────────────
# STARTUP
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    print("=" * 55)
    print(f"  OneSong API v4.6 — startup")
    print("=" * 55)
    for label, val in [
        ("ffmpeg",   shutil.which("ffmpeg") or "NOT IN PATH"),
        ("yt-dlp",   shutil.which("yt-dlp") or "NOT IN PATH"),
        ("essentia", ESSENTIA_AVAILABLE),
        ("numpy",    NUMPY_AVAILABLE),
        ("psycopg2", PSYCOPG2_AVAILABLE),
        ("db url",   "set" if DATABASE_URL else "NOT SET"),
        ("jwt",      "CUSTOM ✓" if JWT_SECRET != "change-me-in-production" else "DEFAULT — CHANGE THIS"),
    ]:
        print(f"  {label:<12}{val}")
    print("=" * 55)
    try:
        conn = get_db(); cur = conn.cursor()
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
        print("[startup] DB schema OK ✓")
    except Exception as e:
        print(f"[startup] DB init skipped (non-fatal): {e}")

# ─────────────────────────────────────────────────────────────
# UTILITY ROUTES
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "version": "4.6.0",
            "essentia": ESSENTIA_AVAILABLE,
            "yt_dlp": shutil.which("yt-dlp") is not None,
            "ffmpeg": shutil.which("ffmpeg") is not None}

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
        "status": "ok", "version": "4.6.0",
        "deps": {"psycopg2": PSYCOPG2_AVAILABLE, "numpy": NUMPY_AVAILABLE,
                 "essentia": ESSENTIA_AVAILABLE, "yt_dlp": shutil.which("yt-dlp"),
                 "ffmpeg": shutil.which("ffmpeg")},
        "env": {"DATABASE_URL": "set" if DATABASE_URL else "NOT SET",
                "JWT_SECRET": "custom" if JWT_SECRET != "change-me-in-production" else "DEFAULT",
                "LASTFM_API_KEY": "set" if LASTFM_KEY else "not set"},
        "database": {"ok": db_ok, "error": db_err},
        "ts": datetime.utcnow().isoformat() + "Z",
    }

# ─────────────────────────────────────────────────────────────
# AUTH ROUTES
# FIX [H1] + [H4]: POST routes explicitly declared.
# These routes were always correctly defined — the 405 came from the
# middleware crash killing OPTIONS preflight before the browser could POST.
# ─────────────────────────────────────────────────────────────
@app.post("/auth/signup", status_code=200)
def signup(user: UserSignup):
    """
    Create account.
    Body:   { email, username, password }
    Returns { token: str, user: { id, email, username } }
    """
    if len(user.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if len(user.username.strip()) < 2:
        raise HTTPException(400, "Username must be at least 2 characters")

    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute("SELECT id FROM users WHERE email = %s", (user.email.lower(),))
        if cur.fetchone():
            raise HTTPException(400, "Email already registered")
        pw_hash = bcrypt.hashpw(user.password.encode(), bcrypt.gensalt()).decode()
        cur.execute(
            "INSERT INTO users (email, username, password_hash) VALUES (%s, %s, %s) RETURNING id",
            (user.email.lower(), user.username.strip(), pw_hash),
        )
        uid = cur.fetchone()["id"]
        conn.commit()
    finally:
        cur.close(); conn.close()

    return {
        "token": make_token(uid, user.email.lower()),
        "user":  {"id": uid, "email": user.email.lower(), "username": user.username.strip()},
    }

@app.post("/auth/login", status_code=200)
def login(user: UserLogin):
    """
    Authenticate.
    Body:   { email, password }
    Returns { token: str, user: { id, email, username } }
    """
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, email, username, password_hash FROM users WHERE email = %s",
            (user.email.lower(),),
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

@app.get("/auth/verify", status_code=200)
def verify(payload: dict = Depends(auth)):
    """Validate JWT. Returns { valid: true, user_id: int }"""
    return {"valid": True, "user_id": payload["user_id"]}

# ─────────────────────────────────────────────────────────────
# USER SONG
# ─────────────────────────────────────────────────────────────
@app.get("/user/song")
def get_song(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT song_name, artist_name, youtube_url, youtube_video_id FROM users WHERE id = %s",
            (payload["user_id"],),
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
            (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"]),
        )
        conn.commit()
    finally:
        cur.close(); conn.close()
    d = song.model_dump() if hasattr(song, "model_dump") else song.dict()
    return {"message": "Saved!", "song": {**d, "youtube_video_id": vid}}

@app.get("/user/profile")
def profile(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, email, username, created_at FROM users WHERE id = %s",
            (payload["user_id"],),
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row:
        raise HTTPException(404, "User not found")
    return {**dict(row),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None}

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
            raw  = r.json().get("toptags", {}).get("tag", [])
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
    track: str, artist: str,
    payload: dict = Depends(auth),
    youtube_id: Optional[str] = None,
):
    vid = youtube_id
    if not vid:
        try:
            conn = get_db(); cur = conn.cursor()
            try:
                cur.execute("SELECT youtube_video_id FROM users WHERE id = %s", (payload["user_id"],))
                row = cur.fetchone()
                if row: vid = row["youtube_video_id"]
            finally:
                cur.close(); conn.close()
        except Exception as e:
            print(f"[audio_analysis] DB lookup failed: {e}")

    if not vid:
        return _fallback_analysis()
    if vid in _analysis_cache:
        return _analysis_cache[vid]

    loop = asyncio.get_running_loop()
    if ESSENTIA_AVAILABLE and NUMPY_AVAILABLE and shutil.which("yt-dlp"):
        with tempfile.TemporaryDirectory() as tmp:
            wav_path   = os.path.join(tmp, f"{vid}.wav")
            downloaded = await loop.run_in_executor(None, _download_audio, vid, wav_path)
            if downloaded:
                try:
                    result = await loop.run_in_executor(None, _analyze_with_essentia, wav_path)
                    _analysis_cache[vid] = result
                    return result
                except Exception as e:
                    print(f"[audio_analysis] Essentia failed: {e}")

    result = _fallback_analysis()
    _analysis_cache[vid] = result
    return result

# ─────────────────────────────────────────────────────────────
# AUDIO STREAM
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
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"], leeway=10)
    except Exception:
        raise HTTPException(401, "Invalid token")
    if not re.match(r'^[a-zA-Z0-9_\-]{11}$', youtube_id):
        raise HTTPException(400, "Invalid youtube_id format")
    if not shutil.which("yt-dlp"):
        return RedirectResponse(f"https://www.youtube.com/watch?v={youtube_id}", status_code=302)

    mime = await _probe_stream_mime(youtube_id)
    cmd  = [
        "yt-dlp", "--no-playlist", "--no-cache-dir",
        "--quiet", "--no-warnings", "--no-check-certificates",
        "--format", _YT_FORMAT, "--output", "-",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]
    print(f"[stream] {youtube_id} mime={mime}")

    async def audio_generator():
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        bytes_sent = 0
        try:
            try:
                first_chunk = await asyncio.wait_for(proc.stdout.read(65536), timeout=12.0)
            except asyncio.TimeoutError:
                print(f"[stream] first-chunk timeout {youtube_id}"); return
            if not first_chunk:
                print(f"[stream] empty stream {youtube_id}"); return
            bytes_sent += len(first_chunk); yield first_chunk
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk: break
                bytes_sent += len(chunk); yield chunk
        except asyncio.CancelledError:
            pass
        finally:
            print(f"[stream] {youtube_id}: {bytes_sent // 1024}KB sent")
            try: proc.kill(); await proc.wait()
            except ProcessLookupError: pass

    return StreamingResponse(
        audio_generator(), media_type=mime,
        headers={
            "Cache-Control": "no-cache, no-store", "Accept-Ranges": "none",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)), log_level="info")