"""
main.py — OneSong API v4.3

Fixes vs v4.2:
  - Startup now runs ALTER TABLE ADD COLUMN IF NOT EXISTS so existing
    databases that were created before song columns were added work correctly
  - Removed python-jose dependency (only PyJWT used)
  - asyncio.get_running_loop() (correct for Python 3.10+ async context)
  - song.model_dump() (Pydantic v2)
  - yt-dlp match_filter uses plain lambda (compatible across all versions)
  - numpy.atleast_1d() around tempo for librosa compat
"""

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import asyncio, concurrent.futures, bcrypt, os, re, httpx
import json, tempfile, shutil
from datetime import datetime, timedelta
from pathlib import Path
from functools import partial

import jwt  # PyJWT only — python-jose must NOT be installed alongside

# ── Optional heavy deps ───────────────────────────────────────
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

try:
    import numpy as np
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False

try:
    import yt_dlp
    YTDLP_AVAILABLE = True
except ImportError:
    YTDLP_AVAILABLE = False

# ── App & CORS ────────────────────────────────────────────────
app = FastAPI()

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

# ── Config ────────────────────────────────────────────────────
JWT_SECRET   = os.getenv("JWT_SECRET", "change-me-in-production")
DATABASE_URL = os.getenv("DATABASE_URL")
LASTFM_KEY   = os.getenv("LASTFM_API_KEY")
LASTFM_BASE  = "https://ws.audioscrobbler.com/2.0/"

_AUDIO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2)

CACHE_DIR = Path(tempfile.gettempdir()) / "onesong_audio_cache"
CACHE_DIR.mkdir(exist_ok=True)
_mem_cache: dict = {}

security = HTTPBearer()

# ── Models ────────────────────────────────────────────────────
class UserSignup(BaseModel):
    email:    EmailStr
    username: str
    password: str

class UserLogin(BaseModel):
    email:    EmailStr
    password: str

class SongData(BaseModel):
    song_name:   str
    artist_name: str
    youtube_url: str

class AudioRequest(BaseModel):
    youtube_url: str

# ── DB helpers ────────────────────────────────────────────────
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
        raise HTTPException(503, "DATABASE_URL not configured")
    try:
        return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    except Exception as e:
        raise HTTPException(503, f"Database unavailable: {e}")

def make_token(user_id: int, email: str) -> str:
    payload = {
        "user_id": user_id,
        "email":   email,
        "exp":     datetime.utcnow() + timedelta(days=7),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    # PyJWT >=2.0 returns str; guard against older versions returning bytes
    return token if isinstance(token, str) else token.decode("utf-8")

def auth(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

# ── Cache ─────────────────────────────────────────────────────
def _cache_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.json"

def _load_cache(video_id: str) -> Optional[dict]:
    if video_id in _mem_cache:
        return _mem_cache[video_id]
    p = _cache_path(video_id)
    if p.exists():
        try:
            data = json.loads(p.read_text())
            _mem_cache[video_id] = data
            return data
        except Exception:
            pass
    return None

def _save_cache(video_id: str, data: dict):
    _mem_cache[video_id] = data
    try:
        _cache_path(video_id).write_text(json.dumps(data))
    except Exception as e:
        print(f"[cache] write failed: {e}")

# ── Audio analysis ────────────────────────────────────────────
def _download_audio(youtube_url: str, output_dir: str) -> str:
    output_tpl = os.path.join(output_dir, "audio.%(ext)s")

    def _duration_filter(info, *, incomplete):
        duration = info.get("duration")
        if duration and duration > 480:
            return "Video too long (>8 min)"
        return None

    ydl_opts = {
        "format":        "bestaudio/best",
        "outtmpl":       output_tpl,
        "quiet":         True,
        "no_warnings":   True,
        "match_filter":  _duration_filter,
        "postprocessors": [{
            "key":            "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([youtube_url])

    wav = os.path.join(output_dir, "audio.wav")
    if os.path.exists(wav):
        return wav
    for f in os.listdir(output_dir):
        if f.startswith("audio."):
            return os.path.join(output_dir, f)
    raise RuntimeError("yt-dlp produced no audio file")


def _run_analysis(youtube_url: str, video_id: str) -> dict:
    """Full pipeline — runs in ThreadPoolExecutor, never on event loop."""
    tmp_dir = tempfile.mkdtemp(prefix="onesong_")
    try:
        print(f"[audio] downloading {video_id}…")
        audio_path = _download_audio(youtube_url, tmp_dir)

        print(f"[audio] analysing…")
        y, sr = librosa.load(audio_path, sr=22050, mono=True)

        # Beats & tempo — atleast_1d handles both scalar and array returns
        tempo_arr, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        tempo      = float(np.atleast_1d(tempo_arr)[0])
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)
        beats      = [{"t": float(t)} for t in beat_times]

        # RMS loudness
        rms      = librosa.feature.rms(y=y)[0]
        t_rms    = librosa.frames_to_time(range(len(rms)), sr=sr)
        peak_rms = float(np.max(rms)) or 1.0
        loudness = [{"t": float(t_rms[i]), "v": float(rms[i] / peak_rms)}
                    for i in range(len(rms))]

        # Spectral centroid
        centroid  = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
        t_spec    = librosa.frames_to_time(range(len(centroid)), sr=sr)
        peak_spec = float(np.max(centroid)) or 1.0
        spectral  = [{"t": float(t_spec[i]), "c": float(centroid[i] / peak_spec)}
                     for i in range(len(centroid))]

        # Bass energy (< 150 Hz)
        S         = np.abs(librosa.stft(y))
        freqs     = librosa.fft_frequencies(sr=sr)
        bass_arr  = S[freqs < 150].mean(axis=0)
        t_bass    = librosa.frames_to_time(range(len(bass_arr)), sr=sr)
        peak_bass = float(np.max(bass_arr)) or 1.0
        bass      = [{"t": float(t_bass[i]), "b": float(bass_arr[i] / peak_bass)}
                     for i in range(len(bass_arr))]

        result = {
            "video_id": video_id,
            "tempo":    tempo,
            "beats":    beats,
            "loudness": loudness,
            "spectral": spectral,
            "bass":     bass,
        }
        print(f"[audio] done — {tempo:.1f} bpm, {len(beats)} beats")
        return result
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ── Startup ───────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    try:
        conn = get_db()
        cur  = conn.cursor()

        # Create table if it doesn't exist yet
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

        # Migrate existing tables that may be missing song columns
        # ADD COLUMN IF NOT EXISTS is safe to run on every startup
        for col, defn in [
            ("song_name",        "VARCHAR(255)"),
            ("artist_name",      "VARCHAR(255)"),
            ("youtube_url",      "TEXT"),
            ("youtube_video_id", "VARCHAR(20)"),
            ("updated_at",       "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ]:
            try:
                cur.execute(
                    f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {defn}"
                )
            except Exception:
                pass  # column already exists or other non-fatal error

        conn.commit()
        cur.close(); conn.close()
        print("[startup] DB ready ✓")
    except Exception as e:
        print(f"[startup] DB init skipped: {e}")


# ── Routes ────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "message": "OneSong API", "version": "4.3.0"}

@app.get("/health")
def health():
    db_ok = False
    try:
        conn = get_db(); conn.close(); db_ok = True
    except Exception:
        pass
    return {
        "status":           "healthy" if db_ok else "degraded",
        "database":         "healthy" if db_ok else "unavailable",
        "psycopg2":         PSYCOPG2_AVAILABLE,
        "librosa":          LIBROSA_AVAILABLE,
        "yt_dlp":           YTDLP_AVAILABLE,
        "database_url_set": bool(DATABASE_URL),
        "timestamp":        datetime.utcnow().isoformat(),
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
        uid = cur.fetchone()["id"]
        conn.commit()
    finally:
        cur.close(); conn.close()
    return {"token": make_token(uid, user.email),
            "user":  {"id": uid, "email": user.email, "username": user.username}}

@app.post("/auth/login")
def login(user: UserLogin):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, email, username, password_hash FROM users WHERE email = %s",
            (user.email,)
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row or not bcrypt.checkpw(user.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    return {"token": make_token(row["id"], row["email"]),
            "user":  {"id": row["id"], "email": row["email"], "username": row["username"]}}

@app.get("/auth/verify")
def verify(payload: dict = Depends(auth)):
    return {"valid": True, "user_id": payload["user_id"], "email": payload["email"]}

@app.get("/user/song")
def get_song(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT song_name, artist_name, youtube_url, youtube_video_id FROM users WHERE id = %s",
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
            """UPDATE users
               SET song_name=%s, artist_name=%s, youtube_url=%s,
                   youtube_video_id=%s, updated_at=CURRENT_TIMESTAMP
               WHERE id=%s""",
            (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"])
        )
        conn.commit()
    finally:
        cur.close(); conn.close()
    return {
        "message": "Saved!",
        "song": {**song.model_dump(), "youtube_video_id": vid}
    }

@app.post("/analyze/audio")
async def analyze_audio(req: AudioRequest, payload: dict = Depends(auth)):
    if not LIBROSA_AVAILABLE:
        raise HTTPException(503, "librosa not installed")
    if not YTDLP_AVAILABLE:
        raise HTTPException(503, "yt-dlp not installed")

    video_id = extract_youtube_id(req.youtube_url)
    if not video_id:
        raise HTTPException(400, "Invalid YouTube URL")

    cached = _load_cache(video_id)
    if cached:
        print(f"[audio] cache hit: {video_id}")
        return cached

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            _AUDIO_EXECUTOR,
            partial(_run_analysis, req.youtube_url, video_id)
        )
    except Exception as e:
        print(f"[audio] failed: {e}")
        raise HTTPException(500, f"Audio analysis failed: {e}")

    _save_cache(video_id, result)
    return result

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
            tags += [t["name"].lower() for t in
                     r2.json().get("toptags", {}).get("tag", [])[:10]]
    return {"tags": tags[:20]}

@app.get("/user/profile")
def profile(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, email, username, created_at FROM users WHERE id = %s",
            (payload["user_id"],)
        )
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row:
        raise HTTPException(404, "User not found")
    return {**dict(row),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))