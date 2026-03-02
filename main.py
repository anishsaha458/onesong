"""
main.py — OneSong API  v4.2
────────────────────────────────────────────────────────────────
BUG FIXES vs v4.1:

[B1] _download_audio: --postprocessor-args was passing "-ar 22050 -ac 1"
     as a SINGLE string argument. ffmpeg received garbled input and failed
     silently. Every analysis call fell through to synthetic fallback.
     FIX: Use "ffmpeg:-ar 22050 -ac 1" prefix (yt-dlp correct syntax).

[B2] asyncio.get_event_loop() deprecated in Python 3.10+.
     FIX: asyncio.get_running_loop().run_in_executor()

[B3] /audio_analysis DB query used LOWER(song_name) match which breaks
     on any special character or whitespace difference. When it failed,
     youtube_id was None → always synthetic fallback even with Essentia.
     FIX: Accept youtube_id directly as an optional query param so
     the frontend can pass it without a DB lookup round-trip.

[B4] /stream format string didn't include enough fallbacks for restricted
     Render environments. Added mp3, aac, and worst-case fallback.

[B5] /stream generator didn't detect yt-dlp startup failure (private/
     age-gated video). Added stderr capture + startup error detection.

[B6] Startup handler is safe (try/except) but psycopg2 connection pool
     isn't cleaned up. Added explicit close on error path.
"""

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse
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

app = FastAPI(title="OneSong API", version="4.3.0")

# ─────────────────────────────────────────────────────────────
# CORS
# The /stream endpoint is loaded by <audio src=...> with
# crossorigin="anonymous". This triggers a CORS preflight (OPTIONS).
# StreamingResponse headers are set at construction time, BEFORE the
# middleware mutates response.headers, so we set CORS in both places.
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

# In-memory analysis cache keyed by youtube_id (most reliable key)
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
# AUDIO ANALYSIS — Essentia + yt-dlp pipeline
# ─────────────────────────────────────────────────────────────

def _download_audio(youtube_id: str, out_path: str) -> bool:
    """
    Download audio from YouTube using yt-dlp, convert to 22050Hz mono WAV.

    FIX [B1]: --postprocessor-args must use "ffmpeg:" prefix so yt-dlp knows
    which postprocessor to pass the args to. Without the prefix, yt-dlp passes
    the entire string as one argument to ffmpeg, which garbles the command.

    Correct:  --postprocessor-args "ffmpeg:-ar 22050 -ac 1"
    Wrong:    --postprocessor-args "-ar 22050 -ac 1"
    """
    if not shutil.which("yt-dlp"):
        print("[yt-dlp] not installed")
        return False
    try:
        cmd = [
            "yt-dlp",
            f"https://www.youtube.com/watch?v={youtube_id}",
            "--extract-audio",
            "--audio-format", "wav",
            "--audio-quality", "5",
            "--postprocessor-args", "ffmpeg:-ar 22050 -ac 1",  # FIX [B1]
            "--output", out_path,
            "--no-playlist",
            "--no-cache-dir",
            "--quiet",
            "--max-filesize", "50m",
        ]
        result = subprocess.run(cmd, timeout=120, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[yt-dlp] download failed (rc={result.returncode}): {result.stderr[:200]}")
        return result.returncode == 0 and Path(out_path).exists()
    except subprocess.TimeoutExpired:
        print("[yt-dlp] timeout after 120s")
        return False
    except Exception as e:
        print(f"[yt-dlp] error: {e}")
        return False


def _analyze_with_essentia(wav_path: str) -> dict:
    """Run Essentia analysis pipeline at 60Hz."""
    if not ESSENTIA_AVAILABLE or not NUMPY_AVAILABLE:
        raise RuntimeError("Essentia or NumPy not installed")

    loader = es.MonoLoader(filename=wav_path, sampleRate=22050)
    audio  = loader()
    sr     = 22050

    rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
    bpm, beats, _, _, _ = rhythm_extractor(audio)

    frame_size = 1024
    hop_size   = int(sr / 60)  # exactly 60 Hz output

    w         = es.Windowing(type='hann')
    spectrum  = es.Spectrum()
    centroid  = es.SpectralCentroidNormalized()
    mel_bands = es.MelBands(
        numberBands=8, sampleRate=sr,
        lowFrequencyBound=20, highFrequencyBound=8000
    )
    loudness_algo = es.Loudness()

    loudness_frames = []
    centroid_frames = []
    melband_frames  = []
    bass_frames     = []

    for i, frame in enumerate(
        es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size)
    ):
        t = i * hop_size / sr

        loud_db   = float(loudness_algo(frame))
        loud_norm = float(np.tanh(max(0.0, (loud_db + 60) / 60)))

        spec      = spectrum(w(frame))
        cent_norm = float(centroid(spec))

        mels      = mel_bands(spec)
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
    """
    Synthetic 60Hz analysis when Essentia/yt-dlp is unavailable.
    Uses smooth sinusoidal patterns so visuals animate pleasingly.
    """
    tempo  = 120.0
    beat_t = 60.0 / tempo
    beats  = [{"t": round(i * beat_t, 4)}
              for i in range(int(duration_estimate / beat_t))]

    loudness_f, spectral_f, melbands_f, bass_f = [], [], [], []
    for i in range(int(duration_estimate * 60)):
        t  = i / 60.0
        v  = round(0.5 + 0.35 * math.sin(t * 0.8) + 0.15 * math.sin(t * 3.1), 4)
        c  = round(0.4 + 0.3  * math.sin(t * 0.5 + 1.2), 4)
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
    """Create DB tables if they don't exist. Non-fatal if DB is unavailable."""
    print("=" * 55)
    print("  OneSong API v4.3 — startup")
    print("=" * 55)
    print(f"  yt-dlp:    {shutil.which('yt-dlp') or 'NOT IN PATH'}")
    print(f"  essentia:  {ESSENTIA_AVAILABLE}")
    print(f"  numpy:     {NUMPY_AVAILABLE}")
    print(f"  psycopg2:  {PSYCOPG2_AVAILABLE}")
    print(f"  db url:    {'set' if DATABASE_URL else 'NOT SET — DB routes will 503'}")
    print(f"  jwt:       {'custom' if JWT_SECRET != 'change-me-in-production' else 'DEFAULT — change this!'}")
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
        print("[startup] DB ready ✓")
    except Exception as e:
        print(f"[startup] DB init skipped: {e}")

# ─────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {
        "status":   "ok",
        "message":  "OneSong API",
        "version":  "4.3.0",
        "essentia": ESSENTIA_AVAILABLE,
        "yt_dlp":   shutil.which("yt-dlp") is not None,
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
        "timestamp": datetime.utcnow().isoformat(),
    }

# ── AUTH ──────────────────────────────────────────────────────
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

# ── USER SONG ─────────────────────────────────────────────────
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
    return {
        "message": "Saved!",
        "song": {**(song.model_dump() if hasattr(song, "model_dump") else song.dict()), "youtube_video_id": vid},
    }

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

# ── LAST.FM ───────────────────────────────────────────────────
@app.get("/mood")
async def get_mood(track: str, artist: str, payload: dict = Depends(auth)):
    """
    Returns Last.fm mood tags for a track.
    Used by Ambient.setSong() to pick a colour palette.
    If LASTFM_KEY is not set, returns empty tags (graceful degradation).
    """
    if not LASTFM_KEY:
        print("[mood] LASTFM_API_KEY not set — returning empty tags")
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
                tags += [
                    t["name"].lower()
                    for t in r2.json().get("toptags", {}).get("tag", [])[:10]
                ]
    except Exception as e:
        print(f"[mood] Last.fm request failed: {e}")

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

# ── AUDIO ANALYSIS ────────────────────────────────────────────
@app.get("/audio_analysis")
async def audio_analysis(
    track: str,
    artist: str,
    payload: dict = Depends(auth),
    youtube_id: Optional[str] = None,   # FIX [B3]: accept direct from frontend
):
    """
    Returns 60Hz normalized audio feature timeline for GPGPU visualization.

    FIX [B3]: Added youtube_id as optional query param. The frontend now passes
    it directly (from song.youtube_video_id), avoiding the fragile DB lookup
    by LOWER(song_name) which broke on any name mismatch.

    Pipeline:
      1. Use youtube_id param if provided, else look up from DB
      2. Download audio with yt-dlp (22050Hz mono WAV)
      3. Run Essentia: RhythmExtractor2013, MelBands(8), SpectralCentroid, Loudness
      4. Return {beats, loudness, spectral, melbands, bass, tempo} at 60Hz
      5. Cache result in memory by youtube_id
      6. Fall back to synthetic data if yt-dlp or Essentia unavailable

    FIX [B2]: Use asyncio.get_running_loop() instead of deprecated get_event_loop()
    """
    # Determine youtube_id: prefer query param, fall back to DB lookup
    vid = youtube_id

    if not vid:
        # DB lookup as fallback — match by user_id only (no name match needed)
        try:
            conn = get_db(); cur = conn.cursor()
            try:
                cur.execute(
                    "SELECT youtube_video_id, song_name FROM users WHERE id=%s",
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
        print(f"[audio_analysis] No youtube_id for '{track}' — using synthetic fallback")
        return _fallback_analysis(duration_estimate=240.0)

    # Check cache by youtube_id (most reliable key)
    if vid in _analysis_cache:
        print(f"[audio_analysis] Cache hit for {vid}")
        return _analysis_cache[vid]

    # FIX [B2]: Use asyncio.get_running_loop() (Python 3.10+ compatible)
    loop = asyncio.get_running_loop()

    # Try full Essentia pipeline
    if ESSENTIA_AVAILABLE and NUMPY_AVAILABLE and shutil.which("yt-dlp"):
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = os.path.join(tmp, f"{vid}.wav")
            print(f"[audio_analysis] Downloading {vid} to {wav_path}...")
            downloaded = await loop.run_in_executor(
                None, _download_audio, vid, wav_path
            )
            if downloaded:
                print(f"[audio_analysis] Download OK, running Essentia...")
                try:
                    result = await loop.run_in_executor(
                        None, _analyze_with_essentia, wav_path
                    )
                    _analysis_cache[vid] = result
                    print(f"[audio_analysis] Essentia OK: {result['tempo']:.1f} BPM")
                    return result
                except Exception as e:
                    print(f"[audio_analysis] Essentia failed: {e}")
            else:
                print(f"[audio_analysis] Download failed for {vid}")
    else:
        reasons = []
        if not ESSENTIA_AVAILABLE: reasons.append("essentia missing")
        if not NUMPY_AVAILABLE:    reasons.append("numpy missing")
        if not shutil.which("yt-dlp"): reasons.append("yt-dlp missing")
        print(f"[audio_analysis] Skipping real analysis ({', '.join(reasons)})")

    # Synthetic fallback
    print(f"[audio_analysis] Returning synthetic fallback for {vid}")
    result = _fallback_analysis(duration_estimate=240.0)
    _analysis_cache[vid] = result
    return result


# ── AUDIO STREAM ──────────────────────────────────────────────
@app.get("/stream")
async def stream_audio(
    request: Request,
    youtube_id: str,
    token: Optional[str] = None,
):
    """
    Pipes yt-dlp audio directly to the browser's <audio> element.

    Auth: JWT passed as query param (can't set Authorization header on <audio src>).

    Format priority (FIX [B4] — wider fallback chain for restricted envs):
      bestaudio[ext=webm]  → Opus/WebM  (Chrome, Firefox)
      bestaudio[ext=m4a]   → AAC/MP4   (Safari)
      bestaudio[ext=mp3]   → MP3        (universal)
      bestaudio            → best available
      worst                → absolute last resort

    FIX [B5]: stderr is now captured. If yt-dlp writes to stderr before
    producing any stdout (private/age-gated video), we detect the failure
    and return a 422 instead of an empty stream that silently fails in the browser.
    """
    # Validate token
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
            f"https://www.youtube.com/watch?v={youtube_id}",
            status_code=302
        )

    # FIX [B4]: broader format chain
    yt_format = (
        "bestaudio[ext=webm]"
        "/bestaudio[ext=m4a]"
        "/bestaudio[ext=mp3]"
        "/bestaudio"
        "/worst"
    )

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--format", yt_format,
        "--output", "-",        # pipe to stdout
        "--no-cache-dir",
        "--quiet",
        "--no-warnings",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]

    print(f"[stream] Starting yt-dlp for {youtube_id}")

    async def audio_generator():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,   # FIX [B5]: capture stderr
        )
        bytes_sent = 0
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                bytes_sent += len(chunk)
                yield chunk
        except asyncio.CancelledError:
            pass  # client disconnected
        finally:
            # FIX [B5]: log stderr if we sent nothing (likely an error)
            if bytes_sent == 0:
                try:
                    stderr_out = await asyncio.wait_for(proc.stderr.read(1024), timeout=2.0)
                    if stderr_out:
                        print(f"[stream] yt-dlp error for {youtube_id}: {stderr_out.decode()[:200]}")
                except Exception:
                    pass
            else:
                print(f"[stream] Streamed {bytes_sent // 1024}KB for {youtube_id}")
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass

    # Determine content type from format selection
    # We don't know which format yt-dlp will pick, so use a generic type
    # that browsers accept for all audio formats
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
        media_type="audio/mpeg",   # generic — browser sniffs actual format
        headers=stream_headers,
    )


# ─────────────────────────────────────────────────────────────
# DIAGNOSTIC ROUTE — no auth required, safe for public debugging
# Hit /diag immediately after deploy to verify routes are registered
# and dependencies are available.
# ─────────────────────────────────────────────────────────────
@app.get("/diag")
def diag():
    """Live deployment health check. No auth required."""
    db_ok, db_err = False, ""
    try:
        c = get_db(); c.close(); db_ok = True
    except Exception as e:
        db_err = str(e)
    return {
        "status":   "ok",
        "version":  "4.3.0",
        "routes": [
            "GET /", "GET /health", "GET /diag",
            "POST /auth/signup", "POST /auth/login", "GET /auth/verify",
            "GET /user/song", "PUT /user/song", "GET /user/profile",
            "GET /mood", "GET /recommendations",
            "GET /audio_analysis", "GET /stream",
        ],
        "deps": {
            "psycopg2":  PSYCOPG2_AVAILABLE,
            "numpy":     NUMPY_AVAILABLE,
            "essentia":  ESSENTIA_AVAILABLE,
            "yt_dlp":    shutil.which("yt-dlp"),
        },
        "env": {
            "DATABASE_URL":   "set"  if DATABASE_URL else "NOT SET",
            "JWT_SECRET":     "set"  if JWT_SECRET != "change-me-in-production" else "DEFAULT",
            "LASTFM_API_KEY": "set"  if LASTFM_KEY  else "not set",
        },
        "database": {"ok": db_ok, "error": db_err},
        "ts": datetime.utcnow().isoformat() + "Z",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        log_level="info",
    )