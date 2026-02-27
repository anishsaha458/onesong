// Configuration - UPDATE THIS with your Render backend URL
const API_BASE_URL = 'https://onesong.onrender.com'; // CHANGE THIS!

// State
let currentUser = null;
let authToken = null;
let hasSong = false;
let currentSong = null;

// ─────────────────────────────────────────────────────────────
// LOCAL MUSIC RECOMMENDATION ENGINE
// A curated knowledge base of songs with tags for genre, mood,
// tempo, era, and style. We compute a similarity score between
// the user's song and every entry, then surface the top 3.
// No API key or internet needed — runs entirely in the browser.
// ─────────────────────────────────────────────────────────────

const MUSIC_DB = [
  // Classic Rock
  { title: "Bohemian Rhapsody", artist: "Queen", tags: ["classic rock", "epic", "theatrical", "70s", "ballad", "operatic", "slow", "fast"] },
  { title: "Hotel California", artist: "Eagles", tags: ["classic rock", "70s", "guitar", "mellow", "mysterious", "slow"] },
  { title: "Stairway to Heaven", artist: "Led Zeppelin", tags: ["classic rock", "70s", "guitar", "epic", "slow", "mystical", "long"] },
  { title: "Comfortably Numb", artist: "Pink Floyd", tags: ["classic rock", "70s", "psychedelic", "guitar", "slow", "emotional", "epic"] },
  { title: "Don't Stop Me Now", artist: "Queen", tags: ["classic rock", "70s", "upbeat", "fast", "fun", "energetic", "party"] },
  { title: "November Rain", artist: "Guns N' Roses", tags: ["rock", "80s", "ballad", "epic", "slow", "emotional", "guitar"] },
  { title: "Sweet Child O' Mine", artist: "Guns N' Roses", tags: ["rock", "80s", "guitar", "upbeat", "romantic", "fast"] },
  { title: "Free Bird", artist: "Lynyrd Skynyrd", tags: ["classic rock", "70s", "guitar", "epic", "slow", "fast", "long"] },
  { title: "More Than a Feeling", artist: "Boston", tags: ["classic rock", "70s", "upbeat", "guitar", "emotional"] },
  { title: "Dream On", artist: "Aerosmith", tags: ["classic rock", "70s", "ballad", "emotional", "slow", "powerful"] },
  // Pop
  { title: "Blinding Lights", artist: "The Weeknd", tags: ["pop", "synth", "80s vibes", "fast", "upbeat", "night", "emotional", "retro"] },
  { title: "Shape of You", artist: "Ed Sheeran", tags: ["pop", "2010s", "upbeat", "dance", "romance", "catchy"] },
  { title: "Rolling in the Deep", artist: "Adele", tags: ["pop", "soul", "powerful", "emotional", "2010s", "breakup", "upbeat"] },
  { title: "Someone Like You", artist: "Adele", tags: ["pop", "ballad", "emotional", "2010s", "breakup", "slow", "piano"] },
  { title: "Happy", artist: "Pharrell Williams", tags: ["pop", "2010s", "upbeat", "fun", "feel-good", "fast", "dance"] },
  { title: "Shake It Off", artist: "Taylor Swift", tags: ["pop", "2010s", "upbeat", "fun", "fast", "dance", "catchy"] },
  { title: "Anti-Hero", artist: "Taylor Swift", tags: ["pop", "2020s", "introspective", "mid-tempo", "catchy", "emotional"] },
  { title: "As It Was", artist: "Harry Styles", tags: ["pop", "2020s", "synth", "emotional", "upbeat", "catchy"] },
  { title: "Levitating", artist: "Dua Lipa", tags: ["pop", "disco", "2020s", "upbeat", "dance", "fun", "fast"] },
  { title: "Bad Guy", artist: "Billie Eilish", tags: ["pop", "dark", "2010s", "bass", "moody", "cool", "slow"] },
  { title: "Therefore I Am", artist: "Billie Eilish", tags: ["pop", "dark", "2020s", "bass", "moody", "slow", "attitude"] },
  { title: "Watermelon Sugar", artist: "Harry Styles", tags: ["pop", "2020s", "upbeat", "fun", "catchy", "feel-good"] },
  // Hip-Hop / Rap
  { title: "HUMBLE.", artist: "Kendrick Lamar", tags: ["hip-hop", "rap", "2010s", "bass", "aggressive", "cool", "fast"] },
  { title: "God's Plan", artist: "Drake", tags: ["hip-hop", "rap", "2010s", "slow", "emotional", "melodic", "inspirational"] },
  { title: "Lose Yourself", artist: "Eminem", tags: ["hip-hop", "rap", "2000s", "fast", "motivational", "intense", "rock"] },
  { title: "SICKO MODE", artist: "Travis Scott", tags: ["hip-hop", "trap", "2010s", "bass", "fast", "moody", "dark"] },
  { title: "Alright", artist: "Kendrick Lamar", tags: ["hip-hop", "rap", "2010s", "upbeat", "inspirational", "jazz"] },
  { title: "Old Town Road", artist: "Lil Nas X", tags: ["hip-hop", "country", "2010s", "fun", "catchy", "upbeat"] },
  { title: "Rockstar", artist: "Post Malone", tags: ["hip-hop", "trap", "2010s", "slow", "dark", "bass", "moody"] },
  // R&B / Soul
  { title: "Redbone", artist: "Childish Gambino", tags: ["r&b", "soul", "funk", "2010s", "slow", "moody", "sexy", "groovy"] },
  { title: "Superstition", artist: "Stevie Wonder", tags: ["soul", "funk", "70s", "upbeat", "groovy", "classic", "dance"] },
  { title: "No Scrubs", artist: "TLC", tags: ["r&b", "90s", "upbeat", "attitude", "fun", "catchy"] },
  { title: "Drunk in Love", artist: "Beyoncé", tags: ["r&b", "2010s", "slow", "sexy", "romantic", "bass"] },
  { title: "Crazy in Love", artist: "Beyoncé", tags: ["r&b", "2000s", "upbeat", "energetic", "dance", "catchy"] },
  { title: "I Will Always Love You", artist: "Whitney Houston", tags: ["r&b", "pop", "ballad", "emotional", "powerful", "slow", "90s"] },
  { title: "At Last", artist: "Etta James", tags: ["soul", "jazz", "classic", "slow", "romantic", "emotional"] },
  { title: "What's Going On", artist: "Marvin Gaye", tags: ["soul", "r&b", "70s", "slow", "emotional", "social", "mellow"] },
  // Electronic / Dance
  { title: "One More Time", artist: "Daft Punk", tags: ["electronic", "dance", "2000s", "upbeat", "fun", "euphoric", "fast"] },
  { title: "Get Lucky", artist: "Daft Punk", tags: ["electronic", "funk", "2010s", "groovy", "upbeat", "dance", "feel-good"] },
  { title: "Blue (Da Ba Dee)", artist: "Eiffel 65", tags: ["electronic", "dance", "90s", "upbeat", "fun", "fast", "catchy"] },
  { title: "Sandstorm", artist: "Darude", tags: ["electronic", "trance", "2000s", "fast", "energetic", "intense"] },
  { title: "Levels", artist: "Avicii", tags: ["electronic", "edm", "2010s", "upbeat", "euphoric", "fast", "feel-good"] },
  { title: "Animals", artist: "Martin Garrix", tags: ["electronic", "edm", "2010s", "fast", "energetic", "intense", "bass"] },
  { title: "Lean On", artist: "Major Lazer", tags: ["electronic", "pop", "2010s", "upbeat", "fun", "catchy", "dance"] },
  // Indie / Alternative
  { title: "Mr. Brightside", artist: "The Killers", tags: ["indie", "rock", "2000s", "upbeat", "emotional", "guitar", "fast"] },
  { title: "Take Me Out", artist: "Franz Ferdinand", tags: ["indie", "rock", "2000s", "upbeat", "dance", "guitar", "cool"] },
  { title: "Seven Nation Army", artist: "The White Stripes", tags: ["rock", "indie", "2000s", "bass", "cool", "slow", "intense"] },
  { title: "Creep", artist: "Radiohead", tags: ["alternative", "rock", "90s", "slow", "emotional", "dark", "guitar"] },
  { title: "Smells Like Teen Spirit", artist: "Nirvana", tags: ["rock", "grunge", "90s", "fast", "intense", "guitar", "aggressive"] },
  { title: "Wonderwall", artist: "Oasis", tags: ["indie", "rock", "90s", "guitar", "slow", "romantic", "emotional"] },
  { title: "Africa", artist: "Toto", tags: ["pop", "rock", "80s", "upbeat", "feel-good", "catchy", "guitar"] },
  { title: "Come As You Are", artist: "Nirvana", tags: ["rock", "grunge", "90s", "slow", "moody", "guitar"] },
  { title: "Everlong", artist: "Foo Fighters", tags: ["rock", "alternative", "90s", "fast", "emotional", "guitar", "epic"] },
  // Country
  { title: "Take Me Home, Country Roads", artist: "John Denver", tags: ["country", "folk", "70s", "upbeat", "nostalgic", "feel-good", "guitar"] },
  { title: "Friends in Low Places", artist: "Garth Brooks", tags: ["country", "90s", "upbeat", "fun", "party", "sing-along"] },
  { title: "Jolene", artist: "Dolly Parton", tags: ["country", "70s", "emotional", "slow", "guitar", "storytelling"] },
  { title: "Before He Cheats", artist: "Carrie Underwood", tags: ["country", "2000s", "emotional", "mid-tempo", "attitude", "powerful"] },
  // Jazz / Blues
  { title: "So What", artist: "Miles Davis", tags: ["jazz", "cool", "60s", "slow", "mellow", "instrumental"] },
  { title: "Take Five", artist: "Dave Brubeck Quartet", tags: ["jazz", "60s", "cool", "mid-tempo", "instrumental", "mellow"] },
  { title: "Feeling Good", artist: "Nina Simone", tags: ["jazz", "soul", "60s", "slow", "powerful", "emotional", "inspirational"] },
  // Latin
  { title: "Despacito", artist: "Luis Fonsi", tags: ["latin", "reggaeton", "2010s", "upbeat", "dance", "romantic", "fun"] },
  { title: "La Bamba", artist: "Ritchie Valens", tags: ["latin", "rock", "50s", "upbeat", "fun", "fast", "dance"] },
  { title: "Smooth", artist: "Santana", tags: ["latin", "rock", "guitar", "90s", "groovy", "upbeat", "sexy"] },
  // 80s / Synth
  { title: "Take On Me", artist: "a-ha", tags: ["pop", "80s", "synth", "upbeat", "fun", "catchy", "romantic"] },
  { title: "Girls Just Want to Have Fun", artist: "Cyndi Lauper", tags: ["pop", "80s", "upbeat", "fun", "feel-good", "catchy"] },
  { title: "Don't You (Forget About Me)", artist: "Simple Minds", tags: ["pop", "rock", "80s", "emotional", "mid-tempo", "nostalgic"] },
  { title: "Sweet Dreams", artist: "Eurythmics", tags: ["pop", "synth", "80s", "moody", "dark", "mid-tempo", "cool"] },
  { title: "Time After Time", artist: "Cyndi Lauper", tags: ["pop", "80s", "slow", "emotional", "romantic", "piano"] },
  { title: "Every Breath You Take", artist: "The Police", tags: ["pop", "rock", "80s", "slow", "moody", "guitar", "obsessive"] },
  // Classics / Timeless
  { title: "Yesterday", artist: "The Beatles", tags: ["pop", "rock", "60s", "slow", "emotional", "piano", "acoustic", "nostalgic"] },
  { title: "Let It Be", artist: "The Beatles", tags: ["pop", "rock", "60s", "slow", "inspirational", "piano", "emotional"] },
  { title: "Hey Jude", artist: "The Beatles", tags: ["pop", "rock", "60s", "emotional", "uplifting", "slow", "epic"] },
  { title: "My Generation", artist: "The Who", tags: ["rock", "60s", "fast", "aggressive", "cool", "attitude"] },
  { title: "Purple Haze", artist: "Jimi Hendrix", tags: ["rock", "psychedelic", "60s", "guitar", "intense", "upbeat"] },
  { title: "Johnny B. Goode", artist: "Chuck Berry", tags: ["rock", "50s", "fast", "fun", "guitar", "upbeat", "classic"] },
  { title: "Respect", artist: "Aretha Franklin", tags: ["soul", "r&b", "60s", "upbeat", "powerful", "feel-good", "classic"] },
  { title: "Born to Run", artist: "Bruce Springsteen", tags: ["rock", "70s", "epic", "upbeat", "guitar", "emotional"] },
  { title: "American Pie", artist: "Don McLean", tags: ["folk", "rock", "70s", "slow", "nostalgic", "storytelling", "long"] },
  // 2020s
  { title: "drivers license", artist: "Olivia Rodrigo", tags: ["pop", "2020s", "slow", "emotional", "breakup", "piano", "ballad"] },
  { title: "good 4 u", artist: "Olivia Rodrigo", tags: ["pop", "rock", "2020s", "fast", "upbeat", "attitude", "fun"] },
  { title: "Peaches", artist: "Justin Bieber", tags: ["pop", "r&b", "2020s", "slow", "groovy", "romantic", "chill"] },
  { title: "Stay", artist: "The Kid LAROI & Justin Bieber", tags: ["pop", "2020s", "upbeat", "fast", "catchy", "emotional"] },
  { title: "Heat Waves", artist: "Glass Animals", tags: ["indie", "pop", "2020s", "slow", "emotional", "dreamy", "synth"] },
  { title: "Montero", artist: "Lil Nas X", tags: ["pop", "hip-hop", "2020s", "upbeat", "fun", "attitude", "catchy"] },
  { title: "About Damn Time", artist: "Lizzo", tags: ["pop", "funk", "2020s", "upbeat", "feel-good", "dance", "empowering"] },
];

// Extract likely tags from a song name + artist string using keyword heuristics
function inferTagsFromText(text) {
  const t = text.toLowerCase();
  const inferred = [];

  const keywordMap = {
    "love": ["romantic", "emotional"],
    "night": ["night", "dark", "moody"],
    "dance": ["dance", "upbeat"],
    "cry": ["emotional", "slow", "ballad"],
    "dream": ["dreamy", "slow"],
    "run": ["fast", "energetic"],
    "fire": ["intense", "fast", "energetic"],
    "rain": ["slow", "emotional", "moody"],
    "sun": ["upbeat", "feel-good"],
    "fly": ["upbeat", "inspirational"],
    "death|dead|die": ["dark", "slow", "emotional"],
    "happy|joy": ["upbeat", "feel-good", "fun"],
    "sad|blue": ["slow", "emotional", "dark"],
    "rock": ["rock", "guitar"],
    "soul": ["soul", "emotional"],
    "jazz": ["jazz", "mellow"],
    "blues": ["blues", "guitar", "slow"],
    "funk": ["funk", "groovy", "upbeat"],
    "electric|synth": ["synth", "electronic"],
    "acoustic": ["acoustic", "guitar", "slow"],
    "piano": ["piano", "slow"],
    "party": ["party", "upbeat", "fun"],
    "god|heaven|angel": ["inspirational", "slow", "emotional"],
    "street|city": ["cool", "urban"],
    "summer": ["feel-good", "upbeat"],
    "winter|cold": ["slow", "moody"],
  };

  for (const [pattern, tags] of Object.entries(keywordMap)) {
    if (new RegExp(pattern).test(t)) inferred.push(...tags);
  }
  return inferred;
}

// Jaccard similarity between two tag arrays
function similarity(tagsA, tagsB) {
  const setA = new Set(tagsA);
  const setB = new Set(tagsB);
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function getRecommendations() {
  if (!currentSong) return;

  const recBtn = document.getElementById('rec-btn');
  const recSection = document.getElementById('recommendations-section');
  const recList = document.getElementById('rec-list');

  recBtn.disabled = true;
  recBtn.textContent = '✦ Finding matches...';

  // Give the UI a moment to update before doing the work
  setTimeout(() => {
    const searchText = `${currentSong.song_name} ${currentSong.artist_name}`;
    const inferredTags = inferTagsFromText(searchText);

    // Find the user's song in the DB if it exists, merge its tags
    const knownEntry = MUSIC_DB.find(
      e => e.title.toLowerCase() === currentSong.song_name.toLowerCase() ||
           e.artist.toLowerCase() === currentSong.artist_name.toLowerCase()
    );
    const userTags = knownEntry
      ? [...new Set([...knownEntry.tags, ...inferredTags])]
      : inferredTags;

    // Score every DB entry, exclude the user's own song
    const scored = MUSIC_DB
      .filter(e => e.title.toLowerCase() !== currentSong.song_name.toLowerCase())
      .map(e => ({
        ...e,
        score: similarity(userTags, e.tags),
        // Add tiny random noise so ties aren't always the same order
        tiebreak: Math.random() * 0.01,
      }))
      .sort((a, b) => (b.score + b.tiebreak) - (a.score + a.tiebreak));

    const top3 = scored.slice(0, 3);

    // Render
    recList.innerHTML = top3.map((rec, i) => {
      const matchPct = Math.round(rec.score * 100);
      const sharedTags = rec.tags
        .filter(t => userTags.includes(t))
        .slice(0, 3)
        .join(', ');
      const reason = sharedTags
        ? `Shares a ${sharedTags} vibe with your song.`
        : `A great stylistic complement to your taste.`;
      const query = encodeURIComponent(`${rec.title} ${rec.artist}`);

      return `
        <div class="rec-item">
          <div class="rec-item-header">
            <div class="rec-item-info">
              <div class="rec-song-title">${rec.title}</div>
              <div class="rec-artist">${rec.artist}</div>
            </div>
            <div class="rec-match">${matchPct}% match</div>
          </div>
          <div class="rec-reason">🎵 ${reason}</div>
          <a class="rec-search-link"
             href="https://www.youtube.com/results?search_query=${query}"
             target="_blank" rel="noopener noreferrer">
            Search on YouTube →
          </a>
        </div>`;
    }).join('');

    recSection.classList.remove('hidden');
    recBtn.textContent = '✦ Refresh Recommendations';
    recBtn.disabled = false;
  }, 300);
}

// ─────────────────────────────────────────────
// AUTH & APP LOGIC
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => { checkAuth(); });

function checkAuth() {
  authToken = localStorage.getItem('authToken');
  const userStr = localStorage.getItem('currentUser');
  if (authToken && userStr) {
    currentUser = JSON.parse(userStr);
    verifyToken();
  } else {
    showAuthContainer();
  }
}

async function verifyToken() {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/verify`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (response.ok) { showAppContainer(); loadUserSong(); }
    else logout();
  } catch { logout(); }
}

function showAuthContainer() {
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

function showAppContainer() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('username-display').textContent = currentUser.username;
}

function showLoading() { document.getElementById('loading').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading').classList.add('hidden'); }

function showSignup() {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('signup-form').classList.remove('hidden');
  clearAuthError();
}
function showLogin() {
  document.getElementById('signup-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  clearAuthError();
}
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.classList.remove('hidden');
}
function clearAuthError() { document.getElementById('auth-error').classList.add('hidden'); }
function showFormError(msg) {
  const el = document.getElementById('song-form-error');
  el.textContent = msg; el.classList.remove('hidden');
}
function clearFormError() { document.getElementById('song-form-error').classList.add('hidden'); }

async function signup() {
  const email = document.getElementById('signup-email').value.trim();
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!email || !username || !password) { showAuthError('Please fill in all fields'); return; }
  if (password.length < 6) { showAuthError('Password must be at least 6 characters'); return; }
  showLoading(); clearAuthError();
  try {
    const response = await fetch(`${API_BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password })
    });
    const data = await response.json();
    if (response.ok) {
      authToken = data.token; currentUser = data.user;
      localStorage.setItem('authToken', authToken);
      localStorage.setItem('currentUser', JSON.stringify(currentUser));
      showAppContainer(); showSongSelection();
    } else { showAuthError(data.detail || 'Signup failed'); }
  } catch { showAuthError('Could not connect to server. Try again shortly.'); }
  finally { hideLoading(); }
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showAuthError('Please fill in all fields'); return; }
  showLoading(); clearAuthError();
  try {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    if (response.ok) {
      authToken = data.token; currentUser = data.user;
      localStorage.setItem('authToken', authToken);
      localStorage.setItem('currentUser', JSON.stringify(currentUser));
      showAppContainer(); loadUserSong();
    } else { showAuthError(data.detail || 'Login failed'); }
  } catch { showAuthError('Could not connect to server. Try again shortly.'); }
  finally { hideLoading(); }
}

function logout() {
  authToken = null; currentUser = null; hasSong = false; currentSong = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
  showAuthContainer();
}

async function loadUserSong() {
  showLoading();
  try {
    const response = await fetch(`${API_BASE_URL}/user/song`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await response.json();
    if (response.ok && data.has_song) {
      hasSong = true; currentSong = data.song; displaySong(data.song);
    } else { hasSong = false; showSongSelection(); }
  } catch { showSongSelection(); }
  finally { hideLoading(); }
}

// ─────────────────────────────────────────────
// YOUTUBE EMBED FIX
// Uses youtube-nocookie.com to bypass most
// embedding restrictions, plus proper attributes.
// ─────────────────────────────────────────────
function buildYouTubeEmbed(videoId) {
  const origin = encodeURIComponent(window.location.origin || 'https://localhost');
  return `<iframe
    width="100%" height="100%"
    src="https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1&origin=${origin}"
    title="YouTube video player"
    frameborder="0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowfullscreen
    referrerpolicy="strict-origin-when-cross-origin">
  </iframe>`;
}

function displaySong(song) {
  document.getElementById('song-display').classList.remove('hidden');
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('welcome-text').textContent = `Hello, ${currentUser.username}`;
  document.getElementById('song-name').textContent = song.song_name;
  document.getElementById('song-artist').textContent = song.artist_name;
  document.getElementById('youtube-player').innerHTML = buildYouTubeEmbed(song.youtube_video_id);

  // Reset recommendations
  document.getElementById('recommendations-section').classList.add('hidden');
  const recBtn = document.getElementById('rec-btn');
  recBtn.disabled = false;
  recBtn.textContent = '✦ Get Song Recommendations';
}

function showSongSelection() {
  document.getElementById('song-display').classList.add('hidden');
  document.getElementById('song-selection').classList.remove('hidden');
  document.getElementById('input-song-name').value = '';
  document.getElementById('input-artist-name').value = '';
  document.getElementById('input-youtube-url').value = '';
  document.getElementById('cancel-btn').style.display = hasSong ? 'block' : 'none';
  clearFormError();
}

function cancelSongSelection() {
  document.getElementById('song-selection').classList.add('hidden');
  document.getElementById('song-display').classList.remove('hidden');
}

async function saveSong() {
  const song_name = document.getElementById('input-song-name').value.trim();
  const artist_name = document.getElementById('input-artist-name').value.trim();
  const youtube_url = document.getElementById('input-youtube-url').value.trim();
  if (!song_name || !artist_name || !youtube_url) { showFormError('Please fill in all three fields'); return; }
  if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) {
    showFormError('Please enter a valid YouTube URL'); return;
  }
  showLoading(); clearFormError();
  try {
    const response = await fetch(`${API_BASE_URL}/user/song`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_name, artist_name, youtube_url })
    });
    const data = await response.json();
    if (response.ok) {
      hasSong = true; currentSong = data.song; displaySong(data.song);
    } else { showFormError(data.detail || 'Failed to save song'); }
  } catch { showFormError('Could not connect to server. Try again shortly.'); }
  finally { hideLoading(); }
}