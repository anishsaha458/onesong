from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import jwt
import bcrypt
import os
import re
import httpx
from datetime import datetime, timedelta

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

app = FastAPI()

# ─────────────────────────────────────────────────────────────
# CORS middleware — wraps EVERY response including unhandled 500s
# ─────────────────────────────────────────────────────────────
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
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

# ─────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────
JWT_SECRET   = os.getenv("JWT_SECRET", "change-me-in-production")
DATABASE_URL = os.getenv("DATABASE_URL")
LASTFM_KEY   = os.getenv("LASTFM_API_KEY")
LASTFM_BASE  = "https://ws.audioscrobbler.com/2.0/"

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
        raise HTTPException(503, "psycopg2 not installed — check requirements.txt")
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not set in Render environment variables")
    try:
        return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    except Exception as e:
        print(f"[DB] connection failed: {e}")
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
        raise HTTPException(401, "Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

# ─────────────────────────────────────────────────────────────
# STARTUP — never crash even if DB is missing
# ─────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    try:
        conn = get_db()
        cur = conn.cursor()
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
        print(f"[startup] DB init skipped (will retry on first request): {e}")

# ─────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"status": "ok", "message": "OneSong API", "version": "3.2.0"}

@app.get("/health")
def health():
    db_ok = False
    try:
        conn = get_db(); conn.close(); db_ok = True
    except Exception:
        pass
    return {
        "status": "healthy" if db_ok else "degraded",
        "database": "healthy" if db_ok else "unavailable",
        "psycopg2": PSYCOPG2_AVAILABLE,
        "database_url_set": bool(DATABASE_URL),
        "timestamp": datetime.utcnow().isoformat(),
    }

@app.post("/auth/signup")
def signup(user: UserSignup):
    conn = get_db()
    cur = conn.cursor()
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
            "user": {"id": uid, "email": user.email, "username": user.username}}

@app.post("/auth/login")
def login(user: UserLogin):
    conn = get_db()
    cur = conn.cursor()
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
            """UPDATE users SET song_name=%s,artist_name=%s,youtube_url=%s,
               youtube_video_id=%s,updated_at=CURRENT_TIMESTAMP WHERE id=%s""",
            (song.song_name, song.artist_name, song.youtube_url, vid, payload["user_id"])
        )
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
    """Fetch Last.fm tags and return them for client-side mood mapping."""
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
            artist_tags = r2.json().get("toptags", {}).get("tag", [])
            tags += [t["name"].lower() for t in artist_tags[:10]]
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


@app.get("/bpm")
async def get_bpm(track: str, artist: str, payload: dict = Depends(auth)):
    """
    All-in-one endpoint: returns Last.fm mood tags + BPM from AcousticBrainz.
    BPM resolution:
      1. MusicBrainz recording ID lookup
      2. AcousticBrainz high-level data (BPM)
      3. Returns tags so frontend can do layer 2/3/4 fallbacks
    """
    if not LASTFM_KEY:
        raise HTTPException(500, "Last.fm API key not configured")

    tags = []
    bpm  = None

    async with httpx.AsyncClient(timeout=15) as client:

        # ── Step 1: Last.fm tags ──────────────────────────────
        r = await client.get(LASTFM_BASE, params={
            "method": "track.getTopTags", "track": track, "artist": artist,
            "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
        })
        raw_tags = r.json().get("toptags", {}).get("tag", [])
        tags = [t["name"].lower() for t in raw_tags if int(t.get("count", 0)) > 10]

        # Fallback to artist tags if sparse
        if len(tags) < 3:
            r2 = await client.get(LASTFM_BASE, params={
                "method": "artist.getTopTags", "artist": artist,
                "api_key": LASTFM_KEY, "format": "json", "autocorrect": "1",
            })
            artist_tags = r2.json().get("toptags", {}).get("tag", [])
            tags += [t["name"].lower() for t in artist_tags[:10]]

        # ── Step 2: MusicBrainz recording ID ─────────────────
        try:
            mb_url = "https://musicbrainz.org/ws/2/recording"
            mb_r = await client.get(mb_url, params={
                "query": f"recording:{track} AND artist:{artist}",
                "limit": "1", "fmt": "json",
            }, headers={"User-Agent": "OneSong/1.0 (onesong@example.com)"})
            recordings = mb_r.json().get("recordings", [])
            if recordings:
                recording_id = recordings[0].get("id")

                # ── Step 3: AcousticBrainz BPM ───────────────
                if recording_id:
                    ab_url = f"https://acousticbrainz.org/{recording_id}/high-level"
                    ab_r = await client.get(ab_url)
                    if ab_r.status_code == 200:
                        ab_data = ab_r.json()
                        # BPM lives in rhythm_bpm in low-level, but high-level
                        # has tempo classification — try the low-level endpoint
                        ab_ll = await client.get(
                            f"https://acousticbrainz.org/{recording_id}/low-level"
                        )
                        if ab_ll.status_code == 200:
                            ll_data = ab_ll.json()
                            raw_bpm = ll_data.get("rhythm", {}).get("bpm")
                            if raw_bpm and 40 <= float(raw_bpm) <= 220:
                                bpm = round(float(raw_bpm))
        except Exception as e:
            print(f"[BPM] MusicBrainz/AcousticBrainz lookup failed: {e}")

    return {"tags": tags[:20], "bpm": bpm}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))