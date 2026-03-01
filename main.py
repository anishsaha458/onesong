"""
main.py — OneSong API
Adds /analyze/audio: downloads audio via yt-dlp, runs librosa analysis,
caches results in memory (keyed by video ID) and on disk, returns
tempo, beats, loudness, spectral and bass timelines to the frontend.
"""

from fastapi import FastAPI, HTTPException, Depends, Request, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import jwt, bcrypt, os, re, httpx, json, tempfile, shutil
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
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False

try:
    import yt_dlp
    YTDLP_AVAILABLE = True
except ImportError:
    YTDLP_AVAILABLE = False

app = FastAPI()

# ── CORS ──────────────────────────────────────────────────────
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

# Audio analysis cache: video_id → analysis dict (in-memory + disk)
CACHE_DIR = Path(tempfile.gettempdir()) / "onesong_audio_cache"
CACHE_DIR.mkdir(exist_ok=True)
_analysis_cache: dict[str, dict] = {}

security = HTTPBearer()

# ── Pydantic models ───────────────────────────────────────────
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

# ── Helpers ───────────────────────────────────────────────────
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
    return jwt.encode(
        {"user_id": user_id, "email": email, "exp": datetime.utcnow() + timedelta(days=7)},
        JWT_SECRET, algorithm="HS256"
    )

def auth(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

# ── Audio analysis helpers ────────────────────────────────────

def download_audio(youtube_url: str, output_dir: str) -> str:
    """
    Uses yt-dlp to download the best audio stream as a 22050 Hz mono WAV.
    Returns the path to the downloaded file.
    """
    if not YTDLP_AVAILABLE:
        raise RuntimeError("yt-dlp not installed — add it to requirements.txt")

    output_template = os.path.join(output_dir, "audio.%(ext)s")
    ydl_opts = {
        "format":           "bestaudio/best",
        "outtmpl":          output_template,
        "quiet":            True,
        "no_warnings":      True,
        "postprocessors": [{
            "key":            "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }],
        # Limit to 8 minutes to avoid very large files
        "match_filter": yt_dlp.utils.match_filter_func("duration < 480"),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([youtube_url])

    wav_path = os.path.join(output_dir, "audio.wav")
    if not os.path.exists(wav_path):
        # Fallback: find any audio file
        for f in os.listdir(output_dir):
            if f.startswith("audio."):
                return os.path.join(output_dir, f)
        raise RuntimeError("yt-dlp: no audio file produced")
    return wav_path


def analyze_beats(audio_path: str) -> tuple[float, list[dict]]:
    """Returns (tempo_bpm, [{"t": seconds}, ...])"""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    return float(tempo), [{"t": float(t)} for t in beat_times]


def analyze_loudness(audio_path: str) -> list[dict]:
    """Returns [{"t": seconds, "v": 0-1}, ...]  (RMS energy, normalised)"""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    rms   = librosa.feature.rms(y=y)[0]
    times = librosa.frames_to_time(range(len(rms)), sr=sr)
    peak  = float(np.max(rms)) or 1.0
    return [{"t": float(times[i]), "v": float(rms[i] / peak)} for i in range(len(rms))]


def analyze_spectral(audio_path: str) -> list[dict]:
    """Returns [{"t": seconds, "c": 0-1}, ...]  (spectral centroid, normalised)"""
    y, sr     = librosa.load(audio_path, sr=22050, mono=True)
    centroid  = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    times     = librosa.frames_to_time(range(len(centroid)), sr=sr)
    peak      = float(np.max(centroid)) or 1.0
    return [{"t": float(times[i]), "c": float(centroid[i] / peak)} for i in range(len(centroid))]


def analyze_bass(audio_path: str) -> list[dict]:
    """Returns [{"t": seconds, "b": 0-1}, ...]  (sub-150 Hz energy, normalised)"""
    y, sr   = librosa.load(audio_path, sr=22050, mono=True)
    S       = np.abs(librosa.stft(y))
    freqs   = librosa.fft_frequencies(sr=sr)
    bass    = S[freqs < 150].mean(axis=0)
    times   = librosa.frames_to_time(range(len(bass)), sr=sr)
    peak    = float(np.max(bass)) or 1.0
    return [{"t": float(times[i]), "b": float(bass[i] / peak)} for i in range(len(bass))]


def run_full_analysis(audio_path: str, video_id: str) -> dict:
    tempo, beats = analyze_beats(audio_path)
    return {
        "video_id": video_id,
        "tempo":    tempo,
        "beats":    beats,
        "loudness": analyze_loudness(audio_path),
        "spectral": analyze_spectral(audio_path),
        "bass":     analyze_bass(audio_path),
    }


def _cache_path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.json"


def load_from_cache(video_id: str) -> Optional[dict]:
    # 1. In-memory
    if video_id in _analysis_cache:
        return _analysis_cache[video_id]
    # 2. Disk
    p = _cache_path(video_id)
    if p.exists():
        try:
            data = json.loads(p.read_text())
            _analysis_cache[video_id] = data
            return data
        except Exception:
            pass
    return None


def save_to_cache(video_id: str, data: dict):
    _analysis_cache[video_id] = data
    try:
        _cache_path(video_id).write_text(json.dumps(data))
    except Exception as e:
        print(f"[cache] write failed: {e}")

# ── Startup ───────────────────────────────────────────────────
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
        conn.commit()
        cur.close(); conn.close()
        print("[startup] DB ready ✓")
    except Exception as e:
        print(f"[startup] DB init skipped: {e}")

# ── Routes ────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "message": "OneSong API", "version": "4.0.0"}

@app.get("/health")
def health():
    db_ok = False
    try:
        conn = get_db(); conn.close(); db_ok = True
    except Exception:
        pass
    return {
        "status":          "healthy" if db_ok else "degraded",
        "database":        "healthy" if db_ok else "unavailable",
        "psycopg2":        PSYCOPG2_AVAILABLE,
        "librosa":         LIBROSA_AVAILABLE,
        "yt_dlp":          YTDLP_AVAILABLE,
        "database_url_set": bool(DATABASE_URL),
        "timestamp":       datetime.utcnow().isoformat(),
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
            "user":  {"id": uid, "email": user.email, "username": user.username}}

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
            "user":  {"id": row["id"], "email": row["email"], "username": row["username"]}}

@app.get("/auth/verify")
def verify(payload: dict = Depends(auth)):
    return {"valid": True, "user_id": payload["user_id"], "email": payload["email"]}

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
            "UPDATE users SET song_name=%s,artist_name=%s,youtube_url=%s,youtube_video_id=%s,updated_at=CURRENT_TIMESTAMP WHERE id=%s",
            (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"])
        )
        conn.commit()
    finally:
        cur.close(); conn.close()
    return {"message": "Saved!", "song": {**song.dict(), "youtube_video_id": vid}}

# ── /analyze/audio — the new core endpoint ────────────────────
@app.post("/analyze/audio")
async def analyze_audio(req: AudioRequest, payload: dict = Depends(auth)):
    """
    Downloads the YouTube audio stream via yt-dlp, runs librosa analysis,
    caches the result, and returns the full feature timeline.

    Response shape:
    {
        "video_id": str,
        "tempo":    float,
        "beats":    [{"t": float}],
        "loudness": [{"t": float, "v": float}],
        "spectral": [{"t": float, "c": float}],
        "bass":     [{"t": float, "b": float}]
    }
    """
    if not LIBROSA_AVAILABLE:
        raise HTTPException(503, "librosa not installed — add to requirements.txt")
    if not YTDLP_AVAILABLE:
        raise HTTPException(503, "yt-dlp not installed — add to requirements.txt")

    video_id = extract_youtube_id(req.youtube_url)
    if not video_id:
        raise HTTPException(400, "Invalid YouTube URL")

    # Serve from cache if available
    cached = load_from_cache(video_id)
    if cached:
        print(f"[analyze] cache hit: {video_id}")
        return cached

    # Download + analyse in a temp directory (cleaned up after)
    tmp_dir = tempfile.mkdtemp(prefix="onesong_")
    try:
        print(f"[analyze] downloading audio for {video_id}…")
        audio_path = download_audio(req.youtube_url, tmp_dir)

        print(f"[analyze] running librosa on {audio_path}…")
        result = run_full_analysis(audio_path, video_id)

        save_to_cache(video_id, result)
        print(f"[analyze] done: tempo={result['tempo']:.1f} bpm, beats={len(result['beats'])}")
        return result

    except Exception as e:
        print(f"[analyze] error: {e}")
        raise HTTPException(500, f"Audio analysis failed: {e}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

# ── Existing Last.fm routes ───────────────────────────────────
@app.get("/recommendations")
async def recommendations(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        raise HTTPException(500, "Last.fm API key not configured")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(LASTFM_BASE, params={
            "method":"track.getSimilar","track":track,"artist":artist,
            "api_key":LASTFM_KEY,"format":"json","limit":"5","autocorrect":"1",
        })
        raw = r.json().get("similartracks",{}).get("track",[])
        if not raw:
            s = await client.get(LASTFM_BASE, params={
                "method":"track.search","track":track,
                "api_key":LASTFM_KEY,"format":"json","limit":"1",
            })
            hits = s.json().get("results",{}).get("trackmatches",{}).get("track",[])
            if hits:
                found = hits[0] if isinstance(hits,list) else hits
                r2 = await client.get(LASTFM_BASE, params={
                    "method":"track.getSimilar","track":found["name"],
                    "artist":found["artist"],"api_key":LASTFM_KEY,
                    "format":"json","limit":"5","autocorrect":"1",
                })
                raw = r2.json().get("similartracks",{}).get("track",[])
    return {"tracks":[
        {"name":t["name"],"artist":t["artist"]["name"],
         "match":round(float(t.get("match",0))*100),"url":t.get("url","")}
        for t in raw[:3]
    ]}

@app.get("/mood")
async def get_mood(track: str, artist: str, payload: dict = Depends(auth)):
    if not LASTFM_KEY:
        raise HTTPException(500, "Last.fm API key not configured")
    tags = []
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(LASTFM_BASE, params={
            "method":"track.getTopTags","track":track,"artist":artist,
            "api_key":LASTFM_KEY,"format":"json","autocorrect":"1",
        })
        raw = r.json().get("toptags",{}).get("tag",[])
        tags = [t["name"].lower() for t in raw if int(t.get("count",0)) > 10]
        if len(tags) < 3:
            r2 = await client.get(LASTFM_BASE, params={
                "method":"artist.getTopTags","artist":artist,
                "api_key":LASTFM_KEY,"format":"json","autocorrect":"1",
            })
            tags += [t["name"].lower() for t in r2.json().get("toptags",{}).get("tag",[])[:10]]
    return {"tags": tags[:20]}

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