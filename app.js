// Configuration - UPDATE THIS with your Render backend URL
const API_BASE_URL = 'https://your-app-name.onrender.com'; // CHANGE THIS!

// State management
let currentUser = null;
let authToken = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

// Check if user is already logged in
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

// Verify token is still valid
async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE_URL}/auth/verify`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (response.ok) {
            showAppContainer();
            loadUserSong();
        } else {
            logout();
        }
    } catch (error) {
        console.error('Token verification failed:', error);
        logout();
    }
}

// Show/Hide containers
function showAuthContainer() {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app-container').classList.add('hidden');
}

function showAppContainer() {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('username-display').textContent = currentUser.username;
}

function showLoading() {
    document.getElementById('loading').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

// Auth form toggles
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

// Error handling
function showAuthError(message) {
    const errorDiv = document.getElementById('auth-error');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
}

function clearAuthError() {
    document.getElementById('auth-error').classList.add('hidden');
}

function showSearchError(message) {
    const errorDiv = document.getElementById('search-error');
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
}

function clearSearchError() {
    document.getElementById('search-error').classList.add('hidden');
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
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, username, password })
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            
            showAppContainer();
            showSongSelection(); // New user needs to choose a song
        } else {
            showAuthError(data.detail || 'Signup failed');
        }
    } catch (error) {
        console.error('Signup error:', error);
        showAuthError('Network error. Please check if the backend is running.');
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
            headers: {
                'Content-Type': 'application/json',
            },
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
        console.error('Login error:', error);
        showAuthError('Network error. Please check if the backend is running.');
    } finally {
        hideLoading();
    }
}

// Logout
function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    showAuthContainer();
}

// Load user's saved song
async function loadUserSong() {
    showLoading();

    try {
        const response = await fetch(`${API_BASE_URL}/user/song`, {
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        const data = await response.json();

        if (response.ok) {
            if (data.has_song) {
                displaySong(data.song);
            } else {
                showSongSelection();
            }
        } else {
            console.error('Failed to load song');
            showSongSelection();
        }
    } catch (error) {
        console.error('Load song error:', error);
        showSongSelection();
    } finally {
        hideLoading();
    }
}

// Display user's song
function displaySong(song) {
    document.getElementById('song-display').classList.remove('hidden');
    document.getElementById('song-selection').classList.add('hidden');

    // Set welcome message
    document.getElementById('welcome-text').textContent = `Welcome back, ${currentUser.username}!`;

    // Set song info
    document.getElementById('song-name').textContent = song.song_name;
    document.getElementById('song-artist').textContent = song.artist_name;
    document.getElementById('song-album-art').src = song.album_art_url;
    document.getElementById('spotify-link').href = song.spotify_url;

    // Embed Spotify player
    const spotifyPlayer = document.getElementById('spotify-player');
    spotifyPlayer.innerHTML = `
        <iframe 
            style="border-radius:12px" 
            src="https://open.spotify.com/embed/track/${song.spotify_track_id}?utm_source=generator" 
            width="100%" 
            height="152" 
            frameBorder="0" 
            allowfullscreen="" 
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" 
            loading="lazy">
        </iframe>
    `;

    // Show preview player if available
    const previewPlayer = document.getElementById('preview-player');
    if (song.preview_url) {
        previewPlayer.src = song.preview_url;
        previewPlayer.classList.remove('hidden');
    } else {
        previewPlayer.classList.add('hidden');
    }
}

// Show song selection interface
function showSongSelection() {
    document.getElementById('song-display').classList.add('hidden');
    document.getElementById('song-selection').classList.remove('hidden');
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('song-search').value = '';
    clearSearchError();
}

// Cancel song selection (only if user already has a song)
async function cancelSongSelection() {
    loadUserSong(); // Try to reload their existing song
}

// Handle Enter key in search box
function handleSearchEnter(event) {
    if (event.key === 'Enter') {
        searchSongs();
    }
}

// Search for songs
async function searchSongs() {
    const query = document.getElementById('song-search').value.trim();

    if (!query) {
        showSearchError('Please enter a search query');
        return;
    }

    showLoading();
    clearSearchError();

    try {
        const response = await fetch(
            `${API_BASE_URL}/search/songs?query=${encodeURIComponent(query)}`,
            {
                headers: {
                    'Authorization': `Bearer ${authToken}`
                }
            }
        );

        const data = await response.json();

        if (response.ok) {
            displaySearchResults(data.results);
        } else {
            showSearchError(data.detail || 'Search failed');
        }
    } catch (error) {
        console.error('Search error:', error);
        showSearchError('Network error. Please try again.');
    } finally {
        hideLoading();
    }
}

// Display search results
function displaySearchResults(results) {
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '';

    if (results.length === 0) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">No results found. Try a different search.</p>';
        return;
    }

    results.forEach(song => {
        const resultItem = document.createElement('div');
        resultItem.className = 'search-result-item';
        resultItem.onclick = () => selectSong(song);

        resultItem.innerHTML = `
            ${song.album_art ? `<img src="${song.album_art}" alt="Album art">` : '<div style="width: 60px; height: 60px; background: #ddd; border-radius: 8px; margin-right: 15px;"></div>'}
            <div class="search-result-info">
                <h4>${song.name}</h4>
                <p>${song.artist}</p>
            </div>
        `;

        resultsContainer.appendChild(resultItem);
    });
}

// Select a song
async function selectSong(song) {
    if (!confirm(`Set "${song.name}" by ${song.artist} as your favorite song?`)) {
        return;
    }

    showLoading();

    const songData = {
        spotify_track_id: song.id,
        song_name: song.name,
        artist_name: song.artist,
        album_art_url: song.album_art || '',
        preview_url: song.preview_url || null,
        spotify_url: song.spotify_url
    };

    try {
        const response = await fetch(`${API_BASE_URL}/user/song`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(songData)
        });

        if (response.ok) {
            displaySong(songData);
        } else {
            const data = await response.json();
            alert('Failed to save song: ' + (data.detail || 'Unknown error'));
        }
    } catch (error) {
        console.error('Save song error:', error);
        alert('Network error. Please try again.');
    } finally {
        hideLoading();
    }
}