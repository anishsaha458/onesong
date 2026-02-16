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
from datetime import datetime, timedelta
import requests
import base64

app = FastAPI()

# CORS configuration - UPDATE THIS with your GitHub Pages URL
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://yourusername.github.io",  # UPDATE THIS
        "*"  # Remove this in production, it's just for development
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security
security = HTTPBearer()

# Environment variables (set these in Render dashboard)
JWT_SECRET = os.getenv("JWT_SECRET", "your-secret-key-change-this")
DATABASE_URL = os.getenv("DATABASE_URL")
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")

# Pydantic models
class UserSignup(BaseModel):
    email: EmailStr
    username: str
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class SongData(BaseModel):
    spotify_track_id: str
    song_name: str
    artist_name: str
    album_art_url: str
    preview_url: Optional[str] = None
    spotify_url: str

# Database connection
def get_db_connection():
    """Get database connection"""
    try:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        return conn
    except Exception as e:
        print(f"Database connection error: {e}")
        raise HTTPException(status_code=500, detail="Database connection failed")

# Initialize database tables
def init_db():
    """Create tables if they don't exist"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(100) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            spotify_track_id VARCHAR(100),
            song_name VARCHAR(255),
            artist_name VARCHAR(255),
            album_art_url TEXT,
            preview_url TEXT,
            spotify_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    conn.commit()
    cur.close()
    conn.close()

# JWT functions
def create_jwt_token(user_id: int, email: str) -> str:
    """Create JWT token"""
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(days=7)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_jwt_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Verify JWT token and return payload"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

# Spotify API functions
def get_spotify_token() -> str:
    """Get Spotify access token"""
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Spotify credentials not configured")
    
    auth_string = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}"
    auth_bytes = auth_string.encode('utf-8')
    auth_base64 = base64.b64encode(auth_bytes).decode('utf-8')
    
    url = "https://accounts.spotify.com/api/token"
    headers = {
        "Authorization": f"Basic {auth_base64}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {"grant_type": "client_credentials"}
    
    try:
        response = requests.post(url, headers=headers, data=data)
        response.raise_for_status()
        return response.json()['access_token']
    except Exception as e:
        print(f"Spotify token error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get Spotify token")

# Routes
@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "message": "Favorite Song Authentication API",
        "version": "1.0.0"
    }

@app.get("/health")
async def health_check():
    """Detailed health check"""
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
    """Create new user account"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Check if email already exists
    cur.execute("SELECT id FROM users WHERE email = %s", (user.email,))
    if cur.fetchone():
        cur.close()
        conn.close()
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Hash password
    password_hash = bcrypt.hashpw(user.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    
    # Insert user
    cur.execute(
        "INSERT INTO users (email, username, password_hash) VALUES (%s, %s, %s) RETURNING id",
        (user.email, user.username, password_hash)
    )
    user_id = cur.fetchone()['id']
    
    conn.commit()
    cur.close()
    conn.close()
    
    # Create JWT token
    token = create_jwt_token(user_id, user.email)
    
    return {
        "message": "User created successfully",
        "token": token,
        "user": {
            "id": user_id,
            "email": user.email,
            "username": user.username
        }
    }

@app.post("/auth/login")
async def login(user: UserLogin):
    """Login user"""
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Get user by email
    cur.execute(
        "SELECT id, email, username, password_hash FROM users WHERE email = %s",
        (user.email,)
    )
    db_user = cur.fetchone()
    
    cur.close()
    conn.close()
    
    if not db_user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    # Verify password
    if not bcrypt.checkpw(user.password.encode('utf-8'), db_user['password_hash'].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    # Create JWT token
    token = create_jwt_token(db_user['id'], db_user['email'])
    
    return {
        "message": "Login successful",
        "token": token,
        "user": {
            "id": db_user['id'],
            "email": db_user['email'],
            "username": db_user['username']
        }
    }

@app.get("/auth/verify")
async def verify_token(payload: dict = Depends(verify_jwt_token)):
    """Verify if token is valid"""
    return {
        "valid": True,
        "user_id": payload['user_id'],
        "email": payload['email']
    }

@app.get("/search/songs")
async def search_songs(query: str, payload: dict = Depends(verify_jwt_token)):
    """Search for songs on Spotify"""
    if not query or len(query.strip()) == 0:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    
    token = get_spotify_token()
    
    url = "https://api.spotify.com/v1/search"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "q": query,
        "type": "track",
        "limit": 10
    }
    
    try:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        tracks = response.json()['tracks']['items']
        
        # Return simplified data
        results = []
        for track in tracks:
            results.append({
                'id': track['id'],
                'name': track['name'],
                'artist': track['artists'][0]['name'] if track['artists'] else "Unknown",
                'album_art': track['album']['images'][0]['url'] if track['album']['images'] else None,
                'preview_url': track.get('preview_url'),
                'spotify_url': track['external_urls']['spotify']
            })
        
        return {"results": results}
    
    except Exception as e:
        print(f"Spotify search error: {e}")
        raise HTTPException(status_code=500, detail="Failed to search songs")

@app.get("/user/song")
async def get_user_song(payload: dict = Depends(verify_jwt_token)):
    """Get user's favorite song"""
    user_id = payload['user_id']
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute(
        """SELECT spotify_track_id, song_name, artist_name, album_art_url, 
           preview_url, spotify_url FROM users WHERE id = %s""",
        (user_id,)
    )
    user = cur.fetchone()
    
    cur.close()
    conn.close()
    
    if not user or not user['spotify_track_id']:
        return {"has_song": False, "song": None}
    
    return {
        "has_song": True,
        "song": {
            "spotify_track_id": user['spotify_track_id'],
            "song_name": user['song_name'],
            "artist_name": user['artist_name'],
            "album_art_url": user['album_art_url'],
            "preview_url": user['preview_url'],
            "spotify_url": user['spotify_url']
        }
    }

@app.put("/user/song")
async def update_user_song(song: SongData, payload: dict = Depends(verify_jwt_token)):
    """Set or update user's favorite song"""
    user_id = payload['user_id']
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute(
        """UPDATE users SET 
           spotify_track_id = %s,
           song_name = %s,
           artist_name = %s,
           album_art_url = %s,
           preview_url = %s,
           spotify_url = %s,
           updated_at = CURRENT_TIMESTAMP
           WHERE id = %s""",
        (
            song.spotify_track_id,
            song.song_name,
            song.artist_name,
            song.album_art_url,
            song.preview_url,
            song.spotify_url,
            user_id
        )
    )
    
    conn.commit()
    cur.close()
    conn.close()
    
    return {
        "message": "Song updated successfully",
        "song": song.dict()
    }

@app.get("/user/profile")
async def get_user_profile(payload: dict = Depends(verify_jwt_token)):
    """Get user profile information"""
    user_id = payload['user_id']
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute(
        "SELECT id, email, username, created_at FROM users WHERE id = %s",
        (user_id,)
    )
    user = cur.fetchone()
    
    cur.close()
    conn.close()
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "id": user['id'],
        "email": user['email'],
        "username": user['username'],
        "created_at": user['created_at'].isoformat() if user['created_at'] else None
    }

# Initialize database on startup
@app.on_event("startup")
async def startup_event():
    """Initialize database tables on startup"""
    try:
        init_db()
        print("Database initialized successfully")
    except Exception as e:
        print(f"Database initialization error: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)