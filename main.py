"""
main.py — OneSong API  v5.2
────────────────────────────────────────────────────────────────
FIXES vs v5.1
─────────────
[R1] CRASH FIX — confirmed PermissionError on Render startup:
     AUDIO_DIR defaulted to '/audio' and AUDIO_DIR.mkdir() was called at
     MODULE LEVEL (line 58 in v5.1). Render's non-root container user cannot
     create directories at the filesystem root.
     Stack trace from Render logs:
       File "main.py", line 58, in <module>
         AUDIO_DIR.mkdir(parents=True, exist_ok=True)
       PermissionError: [Errno 13] Permission denied: '/audio'
       ==> Exited with status 1
     Fix: default to '/tmp/onesong_audio' (always writable) and move ALL
     mkdir() calls inside lifespan() where failures are caught and logged.

[R2] UPLOAD PIPELINE — shutil streaming to /tmp scratch file:
     upload_song() now streams UploadFile to /tmp/uploads/<uid>.<ext>
     in 1 MB chunks (no full-file RAM buffer), then shutil.move() to
     AUDIO_DIR. Matches the emergency brief exactly.

[R3] AUTH 405 FIX — explicit @app.options() handlers for auth routes:
     Registered before any middleware can shadow them. The global CORS
     middleware handles OPTIONS, but Render's reverse proxy can forward
     OPTIONS to the router for known paths. Explicit handlers guarantee
     204 at the route layer regardless of proxy behaviour.

[R4] CORS middleware uses Response (not JSONResponse) for 204 — correct,
     no body, includes Content-Type header for strict preflight clients.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import jwt, bcrypt, os, httpx, asyncio, shutil, math, subprocess
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

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────
JWT_SECRET   = os.getenv("JWT_SECRET", "change-me-in-production")
DATABASE_URL = os.getenv("DATABASE_URL")
LASTFM_KEY   = os.getenv("LASTFM_API_KEY")
LASTFM_BASE  = "https://ws.audioscrobbler.com/2.0/"

MAX_UPLOAD_MB    = int(os.getenv("MAX_UPLOAD_MB", "50"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

# [R1] /tmp is ALWAYS writable on Render (free tier, paid tier, any region).
#      Attach a Render Disk and set AUDIO_DIR=/mnt/audio for persistence
#      across deploys. Without a disk the uploads live in /tmp (ephemeral)
#      but the process STARTS instead of crashing with PermissionError.
#
#      CRITICAL: Do NOT call .mkdir() here at module level.
#      Module-level code that raises kills the process before uvicorn binds.
#      All directory creation is inside lifespan() below.
AUDIO_DIR   = Path(os.getenv("AUDIO_DIR", "/tmp/onesong_audio"))
TMP_UPLOADS = Path("/tmp/uploads")          # [R2] scratch space during streaming

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".weba"}
MIME_MAP = {
    ".mp3":  "audio/mpeg",
    ".wav":  "audio/wav",
    ".flac": "audio/flac",
    ".ogg":  "audio/ogg",
    ".m4a":  "audio/mp4",
    ".aac":  "audio/aac",
    ".opus": "audio/ogg; codecs=opus",
    ".weba": "audio/webm",
}

_analysis_cache: dict = {}
security = HTTPBearer(auto_error=False)

# ─────────────────────────────────────────────────────────────
# CORS
# ─────────────────────────────────────────────────────────────
CORS_HEADERS = {
    "Access-Control-Allow-Origin":   "*",
    "Access-Control-Allow-Methods":  "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":  "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
}

# ─────────────────────────────────────────────────────────────
# [R1] LIFESPAN — ALL directory creation lives here, never at module level
# ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    # ── startup ──────────────────────────────────────────────
    print("=" * 55)
    print("  OneSong API v5.2 — startup")
    print("=" * 55)

    # Create working dirs here. If this fails it's logged, not fatal.
    # A crash here still lets the server start (lifespan errors are non-fatal
    # to uvicorn's bind step), whereas module-level crashes are always fatal.
    for d in (AUDIO_DIR, TMP_UPLOADS):
        try:
            d.mkdir(parents=True, exist_ok=True)
            print(f"  dir ready      {d}")
        except PermissionError as e:
            print(f"  dir WARNING    cannot create {d}: {e}")
            print(f"  hint: set AUDIO_DIR env var to a writable path, e.g. /tmp/audio")

    audio_count = len(list(AUDIO_DIR.glob("*"))) if AUDIO_DIR.exists() else 0
    for label, val in [
        ("audio dir",   str(AUDIO_DIR)),
        ("tmp uploads", str(TMP_UPLOADS)),
        ("audio files", audio_count),
        ("max upload",  f"{MAX_UPLOAD_MB}MB"),
        ("essentia",    ESSENTIA_AVAILABLE),
        ("numpy",       NUMPY_AVAILABLE),
        ("psycopg2",    PSYCOPG2_AVAILABLE),
        ("db url",      "set" if DATABASE_URL else "NOT SET ⚠"),
        ("jwt",         "CUSTOM ✓" if JWT_SECRET != "change-me-in-production" else "DEFAULT ⚠"),
        ("lastfm",      "set" if LASTFM_KEY else "not set"),
    ]:
        print(f"  {label:<14}{val}")
    print("=" * 55)

    # DB schema init — wrapped so missing DATABASE_URL doesn't abort startup
    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id             SERIAL PRIMARY KEY,
                email          VARCHAR(255) UNIQUE NOT NULL,
                username       VARCHAR(100) NOT NULL,
                password_hash  VARCHAR(255) NOT NULL,
                song_name      VARCHAR(255),
                artist_name    VARCHAR(255),
                audio_filename VARCHAR(255),
                audio_mime     VARCHAR(100),
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        # Non-destructive column migration — each column isolated
        for col, defn in [
            ("audio_filename", "VARCHAR(255)"),
            ("audio_mime",     "VARCHAR(100)"),
        ]:
            try:
                cur.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {defn}")
                conn.commit()
            except Exception as col_err:
                conn.rollback()
                print(f"[startup] migration note for {col}: {col_err}")
        cur.close()
        conn.close()
        print("[startup] DB schema OK ✓")
    except Exception as e:
        print(f"[startup] DB init skipped (non-fatal): {e}")

    yield
    # ── shutdown ─────────────────────────────────────────────
    # Nothing to clean up — /tmp is wiped by the OS on container stop


# ─────────────────────────────────────────────────────────────
# APP — constructed AFTER lifespan is defined
# ─────────────────────────────────────────────────────────────
app = FastAPI(title="OneSong API", version="5.2.0", lifespan=lifespan)


# ─────────────────────────────────────────────────────────────
# CORS MIDDLEWARE — [R4] Response (not JSONResponse) for OPTIONS
# ─────────────────────────────────────────────────────────────
@app.middleware("http")
async def add_cors(request: Request, call_next):
    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={**CORS_HEADERS, "Content-Type": "text/plain"},
        )
    try:
        response = await call_next(request)
    except Exception:
        return Response(status_code=500, headers=CORS_HEADERS)
    for k, v in CORS_HEADERS.items():
        response.headers[k] = v
    return response


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


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────
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
         "exp": datetime.utcnow() + timedelta(days=7),
         "iat": datetime.utcnow()},
        JWT_SECRET, algorithm="HS256",
    )

def auth(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    if not creds:
        raise HTTPException(401, "Authorization header missing")
    try:
        return jwt.decode(creds.credentials, JWT_SECRET, algorithms=["HS256"], leeway=10)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

def _audio_path_for(user_id: int) -> Optional[Path]:
    for ext in ALLOWED_EXTENSIONS:
        p = AUDIO_DIR / f"{user_id}{ext}"
        if p.exists():
            return p
    return None

def _delete_audio_for(user_id: int):
    for ext in ALLOWED_EXTENSIONS:
        p = AUDIO_DIR / f"{user_id}{ext}"
        if p.exists():
            p.unlink()


# ─────────────────────────────────────────────────────────────
# UTILITY ROUTES
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "version": "5.2.0",
            "audio_dir": str(AUDIO_DIR), "essentia": ESSENTIA_AVAILABLE}

@app.get("/health")
def health():
    db_ok = False
    try:
        conn = get_db(); conn.close(); db_ok = True
    except Exception:
        pass
    audio_count = len(list(AUDIO_DIR.glob("*"))) if AUDIO_DIR.exists() else 0
    return {
        "status":        "healthy" if db_ok else "degraded",
        "database":      "healthy" if db_ok else "unavailable",
        "audio_dir":     str(AUDIO_DIR),
        "audio_files":   audio_count,
        "max_upload_mb": MAX_UPLOAD_MB,
        "essentia":      ESSENTIA_AVAILABLE,
        "numpy":         NUMPY_AVAILABLE,
        "timestamp":     datetime.utcnow().isoformat(),
    }

@app.get("/diag")
def diag():
    db_ok, db_err = False, ""
    try:
        c = get_db(); c.close(); db_ok = True
    except Exception as e:
        db_err = str(e)
    return {
        "status": "ok", "version": "5.2.0",
        "deps":  {"psycopg2": PSYCOPG2_AVAILABLE, "numpy": NUMPY_AVAILABLE,
                  "essentia": ESSENTIA_AVAILABLE},
        "env":   {"DATABASE_URL":   "set" if DATABASE_URL else "NOT SET",
                  "JWT_SECRET":     "custom" if JWT_SECRET != "change-me-in-production" else "DEFAULT",
                  "LASTFM_API_KEY": "set" if LASTFM_KEY else "not set",
                  "AUDIO_DIR":      str(AUDIO_DIR)},
        "database": {"ok": db_ok, "error": db_err},
        "ts": datetime.utcnow().isoformat() + "Z",
    }


# ─────────────────────────────────────────────────────────────
# AUTH
# [R3] Explicit OPTIONS handlers for every auth path.
#      FastAPI's middleware handles OPTIONS globally, but Render's proxy
#      sometimes forwards OPTIONS to the router for registered paths.
#      These handlers guarantee a 204 at the route layer so POST routes
#      are never accidentally shadowed or blocked.
# ─────────────────────────────────────────────────────────────
@app.options("/auth/signup")
@app.options("/auth/login")
@app.options("/auth/verify")
async def auth_options():
    return Response(status_code=204, headers=CORS_HEADERS)

@app.post("/auth/signup")
def signup(user: UserSignup):
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

@app.post("/auth/login")
def login(user: UserLogin):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, email, username, password_hash FROM users WHERE email = %s",
            (user.email.lower(),))
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
# USER SONG — GET
# ─────────────────────────────────────────────────────────────
@app.get("/user/song")
def get_song(payload: dict = Depends(auth)):
    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            "SELECT song_name, artist_name, audio_filename, audio_mime FROM users WHERE id = %s",
            (payload["user_id"],))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()
    if not row or not row["song_name"]:
        return {"has_song": False, "song": None}
    audio_path = _audio_path_for(payload["user_id"])
    return {
        "has_song": True,
        "song": {
            "song_name":      row["song_name"],
            "artist_name":    row["artist_name"],
            "audio_filename": row["audio_filename"],
            "audio_mime":     row["audio_mime"],
            "has_audio":      audio_path is not None,
            "stream_url":     f"/stream/{payload['user_id']}",
        }
    }


# ─────────────────────────────────────────────────────────────
# UPLOAD
# [R2] Streams UploadFile to /tmp/uploads/<uid>.<ext> in 1 MB chunks
#      (never holds entire file in RAM), then shutil.move() to AUDIO_DIR.
# ─────────────────────────────────────────────────────────────
@app.options("/user/song/upload")
async def upload_options():
    return Response(status_code=204, headers=CORS_HEADERS)

@app.post("/user/song/upload")
async def upload_song(
    payload:     dict       = Depends(auth),
    song_name:   str        = Form(...),
    artist_name: str        = Form(...),
    file:        UploadFile = File(...),
):
    filename = file.filename or ""
    ext      = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    user_id = payload["user_id"]
    mime    = MIME_MAP.get(ext, "audio/mpeg")

    # Ensure dirs exist — /tmp can be cleared between requests on some Render
    # instances; recreating them here is cheap and defensive.
    TMP_UPLOADS.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    # [R2] Stream to /tmp scratch file — never hold the whole file in RAM
    scratch = TMP_UPLOADS / f"upload_{user_id}{ext}"
    total   = 0
    try:
        with open(scratch, "wb") as out_f:
            while True:
                chunk = await file.read(1024 * 1024)   # 1 MB at a time
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File too large. Max {MAX_UPLOAD_MB} MB.")
                out_f.write(chunk)

        if total < 1024:
            raise HTTPException(400, "File is too small to be valid audio")

        # Atomic move from scratch → permanent location
        _delete_audio_for(user_id)
        dest = AUDIO_DIR / f"{user_id}{ext}"
        shutil.move(str(scratch), str(dest))

    except HTTPException:
        scratch.unlink(missing_ok=True)
        raise
    except Exception as e:
        scratch.unlink(missing_ok=True)
        raise HTTPException(500, f"Upload failed: {e}")

    conn = get_db(); cur = conn.cursor()
    try:
        cur.execute(
            """UPDATE users
               SET song_name=%s, artist_name=%s,
                   audio_filename=%s, audio_mime=%s, updated_at=CURRENT_TIMESTAMP
               WHERE id=%s""",
            (song_name.strip(), artist_name.strip(), filename, mime, user_id),
        )
        conn.commit()
    finally:
        cur.close(); conn.close()

    _analysis_cache.pop(str(user_id), None)
    print(f"[upload] user={user_id} file={filename} size={total // 1024}KB mime={mime}")
    return {
        "message": "Uploaded!",
        "song": {
            "song_name":   song_name.strip(),
            "artist_name": artist_name.strip(),
            "audio_mime":  mime,
            "has_audio":   True,
            "stream_url":  f"/stream/{user_id}",
            "size_kb":     total // 1024,
        }
    }


# ─────────────────────────────────────────────────────────────
# STREAM — range-aware, token via ?token= OR Authorization header
# ─────────────────────────────────────────────────────────────
@app.options("/stream/{user_id}")
async def stream_options(user_id: int):
    return Response(status_code=204, headers=CORS_HEADERS)

@app.get("/stream/{user_id}")
async def stream_audio(
    user_id: int,
    request: Request,
    token:   Optional[str] = None,
):
    resolved_token = token
    if not resolved_token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            resolved_token = auth_header[7:]
    if not resolved_token:
        raise HTTPException(401, "Token required")
    try:
        jwt.decode(resolved_token, JWT_SECRET, algorithms=["HS256"], leeway=10)
    except Exception:
        raise HTTPException(401, "Invalid token")

    audio_path = _audio_path_for(user_id)
    if not audio_path:
        raise HTTPException(404, "No audio file found. Please upload a song first.")

    ext  = audio_path.suffix.lower()
    mime = MIME_MAP.get(ext, "audio/mpeg")
    size = audio_path.stat().st_size

    range_header = request.headers.get("range")
    if range_header:
        try:
            range_val          = range_header.replace("bytes=", "")
            start_str, end_str = range_val.split("-")
            start = int(start_str) if start_str else 0
            end   = int(end_str)   if end_str   else size - 1
        except Exception:
            start, end = 0, size - 1
    else:
        start, end = 0, size - 1

    start  = max(0, start)
    end    = min(end, size - 1)
    length = end - start + 1

    def iter_file(path: Path, s: int, e: int, chunk_size: int = 65536):
        with open(path, "rb") as f:
            f.seek(s)
            remaining = e - s + 1
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range":  f"bytes {start}-{end}/{size}",
        "Accept-Ranges":  "bytes",
        "Content-Length": str(length),
        "Cache-Control":  "no-cache",
        "Access-Control-Allow-Origin":   "*",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    }
    return StreamingResponse(
        iter_file(audio_path, start, end),
        status_code=206 if range_header else 200,
        media_type=mime,
        headers=headers,
    )


# ─────────────────────────────────────────────────────────────
# AUDIO ANALYSIS
# Depends(auth) BEFORE query params — FastAPI resolves deps first.
# es.SpectralCentroid() + manual Hz→[0,1] (SpectralCentroidNormalized
# does not exist in Essentia standard namespace).
# ─────────────────────────────────────────────────────────────
def _analyze_wav(wav_path: str) -> dict:
    loader = es.MonoLoader(filename=wav_path, sampleRate=22050)
    audio  = loader()

    bpm, beats, _, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)

    sr, frame_size, hop_size = 22050, 1024, int(22050 / 60)
    w              = es.Windowing(type="hann")
    spectrum_algo  = es.Spectrum()
    centroid_algo  = es.SpectralCentroid(sampleRate=sr)
    nyquist        = sr / 2.0
    mel_bands_algo = es.MelBands(numberBands=8, sampleRate=sr,
                                  lowFrequencyBound=20, highFrequencyBound=8000)
    loudness_algo  = es.Loudness()
    lf, cf, mf, bf = [], [], [], []

    for i, frame in enumerate(es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size)):
        t         = i * hop_size / sr
        loud_norm = float(np.tanh(max(0.0, (float(loudness_algo(frame)) + 60) / 60)))
        spec      = spectrum_algo(w(frame))
        cent_norm = float(np.clip(float(centroid_algo(spec)) / nyquist, 0.0, 1.0))
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

def _convert_to_wav(src: Path, dst: Path) -> bool:
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src),
             "-ar", "22050", "-ac", "1", "-f", "wav", str(dst)],
            capture_output=True, timeout=120,
        )
        return r.returncode == 0 and dst.exists()
    except Exception as e:
        print(f"[analysis] ffmpeg convert failed: {e}")
        return False

def _fallback_analysis(duration: float = 240.0) -> dict:
    tempo  = 120.0
    beat_t = 60.0 / tempo
    beats  = [{"t": round(i * beat_t, 4)} for i in range(int(duration / beat_t))]
    lf, sf, mf, bf = [], [], [], []
    for i in range(int(duration * 60)):
        t = i / 60.0
        lf.append({"t": round(t, 4), "v": round(0.5 + 0.35*math.sin(t*0.8) + 0.15*math.sin(t*3.1), 4)})
        sf.append({"t": round(t, 4), "c": round(0.4 + 0.3*math.sin(t*0.5 + 1.2), 4)})
        bf.append({"t": round(t, 4), "b": round(0.3 + 0.25*abs(math.sin(t*math.pi*2.0)), 4)})
        mf.append({"t": round(t, 4), "bands": [
            round(0.2 + 0.2*math.sin(t*(0.4 + k*0.15) + k), 4) for k in range(8)
        ]})
    return {"tempo": tempo, "beats": beats, "loudness": lf, "spectral": sf, "melbands": mf, "bass": bf}

@app.get("/audio_analysis")
async def audio_analysis(
    payload: dict = Depends(auth),   # ← dep FIRST: FastAPI resolves Depends() before query params
    track:   str  = "",
    artist:  str  = "",
):
    user_id   = payload["user_id"]
    cache_key = str(user_id)
    if cache_key in _analysis_cache:
        return _analysis_cache[cache_key]

    audio_path = _audio_path_for(user_id)
    if audio_path and ESSENTIA_AVAILABLE and NUMPY_AVAILABLE:
        loop = asyncio.get_running_loop()
        import tempfile
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wav_path = Path(tmp) / "audio.wav"
                if audio_path.suffix.lower() == ".wav":
                    shutil.copy(str(audio_path), str(wav_path))
                    converted = True
                else:
                    converted = await loop.run_in_executor(
                        None, _convert_to_wav, audio_path, wav_path)
                if converted:
                    result = await loop.run_in_executor(None, _analyze_wav, str(wav_path))
                    _analysis_cache[cache_key] = result
                    print(f"[analysis] user={user_id} tempo={result['tempo']} beats={len(result['beats'])}")
                    return result
        except Exception as e:
            print(f"[analysis] Essentia failed: {e}")

    result = _fallback_analysis()
    _analysis_cache[cache_key] = result
    return result


# ─────────────────────────────────────────────────────────────
# LAST.FM mood tags
# ─────────────────────────────────────────────────────────────
@app.get("/mood")
async def get_mood(
    payload: dict = Depends(auth),
    track:   str  = "",
    artist:  str  = "",
):
    if not LASTFM_KEY:
        return {"tags": []}
    tags = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(LASTFM_BASE, params={
                "method": "track.getTopTags", "track": track, "artist": artist,
                "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
            })
            if r.status_code == 200:
                raw  = r.json().get("toptags", {}).get("tag", [])
                tags = [t["name"].lower() for t in raw if int(t.get("count", 0)) > 10]
            if len(tags) < 3:
                r2 = await client.get(LASTFM_BASE, params={
                    "method": "artist.getTopTags", "artist": artist,
                    "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
                })
                if r2.status_code == 200:
                    tags += [t["name"].lower()
                             for t in r2.json().get("toptags", {}).get("tag", [])[:10]]
    except Exception as e:
        print(f"[mood] Last.fm failed: {e}")
    return {"tags": tags[:20]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)), log_level="info")