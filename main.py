from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
import jwt
import bcrypt
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import re
import httpx
from datetime import datetime, timedelta

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "https://anishsaha458.github.io",
        "*"  # Remove in production
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

JWT_SECRET = os.getenv("JWT_SECRET", "your-secret-key-change-this")
DATABASE_URL = os.getenv("DATABASE_URL")
LASTFM_API_KEY = os.getenv("LASTFM_API_KEY")  # Set this in Render dashboard
LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/"

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

def extract_youtube_id(url: str) -> Optional[str]:
    patterns = [
        r'(?:v=|\/)([0-9A-Za-z_-]{11}).*',
        r'(?:embed\/)([0-9A-Za-z_-]{11})',
        r'(?:youtu\.be\/)([0-9A-Za-z_-]{11})',
        r'(?:shorts\/)([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        return conn
    except Exception as e:
        print(f"Database connection error: {e}")
        raise HTTPException(status_code=500, detail="Database connection failed")

def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(100) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            song_name VARCHAR(255),
            artist_name VARCHAR(255),
            youtube_url TEXT,
            youtube_video_id VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    cur.close()
    conn.close()

def create_jwt_token(user_id: int, email: str) -> str:
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(days=7)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_jwt_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        token = credentials.credentials
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

@app.get("/")
async def root():
    return {"status": "healthy", "message": "OneSong API", "version": "3.0.0"}

@app.get("/health")
async def health_check():
    db_status = "healthy"
    try:
        conn = get_db_connection()
        conn.close()
    except:
        db_status = "unhealthy"
    return {
        "status": "healthy" if db_status == "healthy" else "degraded",
        "database": db_status,
        "timestamp": datetime.utcnow().isoformat()
    }

@app.post("/auth/signup")
async def signup(user: UserSignup):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE email = %s", (user.email,))
    if cur.fetchone():
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="Email already registered")
    password_hash = bcrypt.hashpw(user.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cur.execute(
        "INSERT INTO users (email, username, password_hash) VALUES (%s, %s, %s) RETURNING id",
        (user.email, user.username, password_hash)
    )
    user_id = cur.fetchone()['id']
    conn.commit()
    cur.close()
    conn.close()
    token = create_jwt_token(user_id, user.email)
    return {"message": "User created successfully", "token": token, "user": {"id": user_id, "email": user.email, "username": user.username}}

@app.post("/auth/login")
async def login(user: UserLogin):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, email, username, password_hash FROM users WHERE email = %s", (user.email,))
    db_user = cur.fetchone()
    cur.close()
    conn.close()
    if not db_user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not bcrypt.checkpw(user.password.encode('utf-8'), db_user['password_hash'].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_jwt_token(db_user['id'], db_user['email'])
    return {"message": "Login successful", "token": token, "user": {"id": db_user['id'], "email": db_user['email'], "username": db_user['username']}}

@app.get("/auth/verify")
async def verify_token(payload: dict = Depends(verify_jwt_token)):
    return {"valid": True, "user_id": payload['user_id'], "email": payload['email']}

@app.get("/user/song")
async def get_user_song(payload: dict = Depends(verify_jwt_token)):
    user_id = payload['user_id']
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT song_name, artist_name, youtube_url, youtube_video_id FROM users WHERE id = %s", (user_id,))
    user = cur.fetchone()
    cur.close()
    conn.close()
    if not user or not user['youtube_url']:
        return {"has_song": False, "song": None}
    return {"has_song": True, "song": {"song_name": user['song_name'], "artist_name": user['artist_name'], "youtube_url": user['youtube_url'], "youtube_video_id": user['youtube_video_id']}}

@app.put("/user/song")
async def update_user_song(song: SongData, payload: dict = Depends(verify_jwt_token)):
    user_id = payload['user_id']
    video_id = extract_youtube_id(song.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL. Please paste a valid YouTube link.")
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """UPDATE users SET song_name=%s, artist_name=%s, youtube_url=%s, youtube_video_id=%s, updated_at=CURRENT_TIMESTAMP WHERE id=%s""",
        (song.song_name, song.artist_name, song.youtube_url, video_id, user_id)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"message": "Song saved successfully!", "song": {"song_name": song.song_name, "artist_name": song.artist_name, "youtube_url": song.youtube_url, "youtube_video_id": video_id}}

@app.get("/recommendations")
async def get_recommendations(track: str, artist: str, payload: dict = Depends(verify_jwt_token)):
    """Proxy Last.fm track.getSimilar — API key never exposed to browser."""
    if not LASTFM_API_KEY:
        raise HTTPException(status_code=500, detail="Last.fm API key not configured on server.")

    async with httpx.AsyncClient() as client:
        # Try track.getSimilar first
        resp = await client.get(LASTFM_BASE, params={
            "method": "track.getSimilar",
            "track": track,
            "artist": artist,
            "api_key": LASTFM_API_KEY,
            "format": "json",
            "limit": "5",
            "autocorrect": "1",
        })
        data = resp.json()
        raw = data.get("similartracks", {}).get("track", [])

        # Fallback: search then retry getSimilar
        if not raw:
            search_resp = await client.get(LASTFM_BASE, params={
                "method": "track.search",
                "track": track,
                "api_key": LASTFM_API_KEY,
                "format": "json",
                "limit": "1",
            })
            results = search_resp.json().get("results", {}).get("trackmatches", {}).get("track", [])
            if results:
                found = results[0] if isinstance(results, list) else results
                retry = await client.get(LASTFM_BASE, params={
                    "method": "track.getSimilar",
                    "track": found["name"],
                    "artist": found["artist"],
                    "api_key": LASTFM_API_KEY,
                    "format": "json",
                    "limit": "5",
                    "autocorrect": "1",
                })
                raw = retry.json().get("similartracks", {}).get("track", [])

    tracks = [
        {
            "name": t["name"],
            "artist": t["artist"]["name"],
            "match": round(float(t.get("match", 0)) * 100),
            "url": t.get("url", ""),
        }
        for t in raw[:3]
    ]
    return {"tracks": tracks}

@app.get("/user/profile")
async def get_user_profile(payload: dict = Depends(verify_jwt_token)):
    user_id = payload['user_id']
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, email, username, created_at FROM users WHERE id = %s", (user_id,))
    user = cur.fetchone()
    cur.close()
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"id": user['id'], "email": user['email'], "username": user['username'], "created_at": user['created_at'].isoformat() if user['created_at'] else None}

@app.on_event("startup")
async def startup_event():
    try:
        init_db()
        print("Database initialized successfully")
    except Exception as e:
        print(f"Database initialization error: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)