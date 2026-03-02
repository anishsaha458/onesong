This FastAPI backend provides user authentication and allows each user to save their one personal favorite song via a YouTube URL. When users log in, they are greeted with their saved song — creating a meaningful, personalized experience unique to each account.



One Song is a full-stack web application that lets each user enter an mp3 format version of a song. Their one song and watch it breathe
througha GPUGPG particle visualizer. This was possible through using Essentia to parse the song for vocal sounds. A curl-noise field that reacts to every 
beat, kick drum, and high frequency section of the song

The particle lives on the GPU. Position and velocity are stored as render targets inside Three.JS's Computational Renderer. The CPU never touches individual particle data. The fragment shaders run in parallel across the texture.

Three.HalfFloatType was chosen specifically since there is a universal render support across platforms. Three.FloatType can produce black on mobile applications

The EffectComposer pipeline runs at full screen resolution. Bloom strength is driven by sub-bass energy. As a result, kick drums can be seen. 

The structure separates structural audio data from Essentia, JSON timeline which is computed once from the audio from the mp3 file which is computed every 16 ms.
As a result, a live sync is created from the two independent sections of the application.

Running locally:
Python 3.11
PostgreSQL runs locally
ffmpeg on the path(needed for audio format conversion for Essentia)

onesong/
├── main.py              # FastAPI backend — auth, upload, streaming, analysis
├── index.html           # Single-page frontend shell
├── styles.css           # Transparent UI over WebGL canvas
├── app.js               # Auth flow, audio pipeline, upload, playback controls
├── ambient.js           # GPGPU particle engine (GPUComputationRenderer + Bloom)
├── gradientController.js # Essentia JSON timeline interpolator
├── .env.example         # Environment variable template
├── requirements.txt     # Python dependencies
└── README.md


SECRETS/ENVIRONMENTAL Variables
DATABASE_URL PostgreSQL connection string
LASTFM_KEY


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
PUT /user/song. More so, the song is in the format of an mp3 file. The song is then parsed with Essentia to extract important features that can be used to model visually stunning features rich in dynamics and expressive.

Step 4 - Essentia -> Three.JS
The different components of the output file from Essentia can be used to create a fluid and dynamic environment. Essentia has the ability to calculate the different vocal sounds of music. As a result, Essentia can be used to model the musicality of notes. 
When Essentia labels a note as bass, it can be modeled visually. 

Step 5- Modeling with Three.JS
Modeling was split into different sections to represent the different sounds that Essentia was able to analyze. Colors were also used as well to parse the genre of music of which the song was apart of through using the Last.fm API whose database is expansive.

UI could have been better. Will be built upon.



How Secrets Are Handled
All secrets are stored as environment variables — never hardcoded in source code
The .gitignore file prevents .env files from being committed to GitHub
On Render, secrets are set in the Environment Variables dashboard
Passwords are hashed with bcrypt before database storage — plain text is never saved
JWT tokens are signed with JWT_SECRET and expire after 7 days
YouTube URLs are processed on the backend — no third-party API keys required

wanted to create a visually dynamic fluid environment for the song as an additional feature


