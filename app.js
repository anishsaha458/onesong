// Configuration - UPDATE THIS with your Render backend URL
const API_BASE_URL = 'https://onesong.onrender.com'; // CHANGE THIS!

// State
let currentUser = null;
let authToken = null;
let hasSong = false;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

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
        if (response.ok) {
            showAppContainer();
            loadUserSong();
        } else {
            logout();
        }
    } catch (error) {
        logout();
    }
}

// Show/Hide
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
    el.textContent = msg;
    el.classList.remove('hidden');
}

function clearAuthError() {
    document.getElementById('auth-error').classList.add('hidden');
}

function showFormError(msg) {
    const el = document.getElementById('song-form-error');
    el.textContent = msg;
    el.classList.remove('hidden');
}

function clearFormError() {
    document.getElementById('song-form-error').classList.add('hidden');
}

// Signup
async function signup() {
    const email = document.getElementById('signup-email').value.trim();
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;

    if (!email || !username || !password) {
        showAuthError('Please fill in all fields');
        return;
    }
    if (password.length < 6) {
        showAuthError('Password must be at least 6 characters');
        return;
    }

    showLoading();
    clearAuthError();

    try {
        const response = await fetch(`${API_BASE_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, username, password })
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showAppContainer();
            showSongSelection();
        } else {
            showAuthError(data.detail || 'Signup failed');
        }
    } catch (error) {
        showAuthError('Could not connect to server. Try again shortly.');
    } finally {
        hideLoading();
    }
}

// Login
async function login() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        showAuthError('Please fill in all fields');
        return;
    }

    showLoading();
    clearAuthError();

    try {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showAppContainer();
            loadUserSong();
        } else {
            showAuthError(data.detail || 'Login failed');
        }
    } catch (error) {
        showAuthError('Could not connect to server. Try again shortly.');
    } finally {
        hideLoading();
    }
}

// Logout
function logout() {
    authToken = null;
    currentUser = null;
    hasSong = false;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    showAuthContainer();
}

// Load song
async function loadUserSong() {
    showLoading();
    try {
        const response = await fetch(`${API_BASE_URL}/user/song`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();

        if (response.ok && data.has_song) {
            hasSong = true;
            displaySong(data.song);
        } else {
            hasSong = false;
            showSongSelection();
        }
    } catch (error) {
        showSongSelection();
    } finally {
        hideLoading();
    }
}

// Display song
function displaySong(song) {
    document.getElementById('song-display').classList.remove('hidden');
    document.getElementById('song-selection').classList.add('hidden');

    document.getElementById('welcome-text').textContent = `Welcome back, ${currentUser.username}!`;
    document.getElementById('song-name').textContent = song.song_name;
    document.getElementById('song-artist').textContent = song.artist_name;

    // Embed YouTube player
    document.getElementById('youtube-player').innerHTML = `
        <iframe
            width="100%"
            height="315"
            src="https://www.youtube.com/embed/${song.youtube_video_id}?autoplay=0&rel=0"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen>
        </iframe>
    `;
}

// Show song selection form
function showSongSelection() {
    document.getElementById('song-display').classList.add('hidden');
    document.getElementById('song-selection').classList.remove('hidden');
    document.getElementById('input-song-name').value = '';
    document.getElementById('input-artist-name').value = '';
    document.getElementById('input-youtube-url').value = '';

    // Only show cancel button if user already has a song
    document.getElementById('cancel-btn').style.display = hasSong ? 'block' : 'none';
    clearFormError();
}

// Cancel and go back to song display
function cancelSongSelection() {
    document.getElementById('song-selection').classList.add('hidden');
    document.getElementById('song-display').classList.remove('hidden');
}

// Save song
async function saveSong() {
    const song_name = document.getElementById('input-song-name').value.trim();
    const artist_name = document.getElementById('input-artist-name').value.trim();
    const youtube_url = document.getElementById('input-youtube-url').value.trim();

    if (!song_name || !artist_name || !youtube_url) {
        showFormError('Please fill in all three fields');
        return;
    }

    if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) {
        showFormError('Please enter a valid YouTube URL');
        return;
    }

    showLoading();
    clearFormError();

    try {
        const response = await fetch(`${API_BASE_URL}/user/song`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ song_name, artist_name, youtube_url })
        });

        const data = await response.json();

        if (response.ok) {
            hasSong = true;
            displaySong(data.song);
        } else {
            showFormError(data.detail || 'Failed to save song');
        }
    } catch (error) {
        showFormError('Could not connect to server. Try again shortly.');
    } finally {
        hideLoading();
    }
}