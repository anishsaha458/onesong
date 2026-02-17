This FastAPI backend provides user authentication and allows each user to save their one personal favorite song via a YouTube URL. When users log in, they are greeted with their saved song — creating a meaningful, personalized experience unique to each account.

Endpoints
Authentication
POST /auth/signup  —  Create a new user account
  Parameters: email, username, password
  Returns: JWT token + user info

POST /auth/login  —  Login to existing account
  Parameters: email, password
  Returns: JWT token + user info

GET /auth/verify  —  Verify token validity
  Parameters: JWT in Authorization header
  Returns: Valid status + user ID

Song Management (All require JWT token)
GET /user/song  —  Get user's saved favorite song
  Parameters: JWT header
  Returns: Song data or has_song: false

PUT /user/song  —  Save or update favorite song
  Parameters: song_name, artist_name, youtube_url + JWT
  Returns: Confirmation + song data

GET /user/profile  —  Get user profile info
  Parameters: JWT header
  Returns: id, email, username, created_at

Utility
GET /  —  Basic health check, returns API status
GET /health  —  Detailed health check including database status


The frontend (HTML/CSS/JS hosted on GitHub Pages) communicates with this backend through REST API calls using the Fetch API.

Step 1 — Signup or Login
The frontend sends a POST request with credentials. The backend validates them and returns a JWT token.
POST /auth/signup   { email, username, password }
POST /auth/login    { email, password }
Response            { token, user: { id, email, username } }
The frontend stores the token in localStorage for future requests.

Step 2 — Load Song on Login
After login, the frontend immediately calls GET /user/song with the JWT token in the Authorization header.
GET /user/song
Header: Authorization: Bearer <token>
Response: { has_song: true, song: { song_name, artist_name, youtube_video_id } }
If has_song is true, the frontend embeds the YouTube player. If false, the song selection form is shown.

Step 3 — Save a Song
When the user submits the song form, the frontend sends a PUT request with the song details.
PUT /user/song
Body: { song_name, artist_name, youtube_url }
The backend extracts the YouTube video ID automatically from any valid YouTube URL format.

How Secrets Are Handled
All secrets are stored as environment variables — never hardcoded in source code
The .gitignore file prevents .env files from being committed to GitHub
On Render, secrets are set in the Environment Variables dashboard
Passwords are hashed with bcrypt before database storage — plain text is never saved
JWT tokens are signed with JWT_SECRET and expire after 7 days
YouTube URLs are processed on the backend — no third-party API keys required
