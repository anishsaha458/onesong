// ============================================================
// app.js  (classic script — loaded after ambient.js)
// All onclick handlers are plain globals. No ES modules.
//
// KEY FIX: checkAuth() now runs immediately on DOMContentLoaded.
// pingServer() runs in parallel — a slow/down server no longer
// blocks the login form from appearing.
// ============================================================

const API_BASE_URL = 'https://onesong.onrender.com';

// ── State ─────────────────────────────────────────────────────
let currentUser   = null;
let authToken     = null;
let hasSong       = false;
let currentSong   = null;
let ytPlayer      = null;
let _tickInterval = null;

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, color, spin) {
    color = color || '#a78bfa';
    spin  = spin  || false;
    let el = document.getElementById('wake-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'wake-toast';
        el.style.cssText = [
            'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
            'background:#17171a', 'color:#f0ede8',
            'padding:12px 20px', 'border-radius:12px',
            'font-family:"DM Sans",sans-serif', 'font-size:14px',
            'display:flex', 'align-items:center', 'gap:10px',
            'box-shadow:0 8px 32px rgba(0,0,0,0.5)', 'z-index:10000',
            'transition:opacity 0.4s', 'white-space:nowrap',
            'border:1px solid ' + color
        ].join(';');
        document.body.appendChild(el);
    }
    el.style.borderColor = color;
    el.style.opacity = '1';
    el.style.display = 'flex';
    var spinner = spin
        ? '<div style="width:13px;height:13px;border:2px solid rgba(167,139,250,0.25);'
          + 'border-top-color:' + color + ';border-radius:50%;'
          + 'animation:spin 0.8s linear infinite;flex-shrink:0"></div>'
        : '';
    el.innerHTML = spinner + '<span>' + msg + '</span>';
}
function hideToast() {
    var el = document.getElementById('wake-toast');
    if (el) {
        el.style.opacity = '0';
        setTimeout(function() { if (el) el.style.display = 'none'; }, 400);
    }
}

// Expose to ambient.js
window.showToast = showToast;
window.hideToast = hideToast;

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    Ambient.init();

    // FIXED: run checkAuth immediately — don't wait for server ping.
    // The login form must always appear, even if the server is down.
    checkAuth();

    // Ping server in the background for status toast only
    pingServerBackground();
});

function pingServerBackground() {
    showToast('⏳ Waking up server…', '#a78bfa', true);
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 65000);
    fetch(API_BASE_URL + '/health', { signal: controller.signal })
        .then(function(res) {
            clearTimeout(timeout);
            if (res.ok) {
                showToast('✓ Server ready', '#4ade80');
                setTimeout(hideToast, 2000);
            }
        })
        .catch(function() {
            clearTimeout(timeout);
            showToast('⚠ Server offline — try again shortly', '#e57373');
            setTimeout(hideToast, 4000);
        });
}

// ── Auth ──────────────────────────────────────────────────────
function checkAuth() {
    authToken = localStorage.getItem('authToken');
    var userStr = localStorage.getItem('currentUser');
    if (authToken && userStr) {
        try {
            currentUser = JSON.parse(userStr);
            verifyToken();
        } catch(e) {
            logout();
        }
    } else {
        showAuthContainer();
    }
}

function verifyToken() {
    fetch(API_BASE_URL + '/auth/verify', {
        headers: { 'Authorization': 'Bearer ' + authToken }
    })
    .then(function(r) {
        if (r.ok) { showAppContainer(); loadUserSong(); }
        else logout();
    })
    .catch(function() { logout(); });
}

function showAuthContainer() {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app-container').classList.add('hidden');
    Ambient.reset();
}

function showAppContainer() {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('username-display').textContent = currentUser.username;
}

function showLoading()  { document.getElementById('loading').classList.remove('hidden'); }
function hideLoading()  { document.getElementById('loading').classList.add('hidden'); }

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
    var el = document.getElementById('auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
}
function clearAuthError() { document.getElementById('auth-error').classList.add('hidden'); }
function showFormError(msg) {
    var el = document.getElementById('song-form-error');
    el.textContent = msg;
    el.classList.remove('hidden');
}
function clearFormError() { document.getElementById('song-form-error').classList.add('hidden'); }

// ── Auth actions ──────────────────────────────────────────────
function signup() {
    var email    = document.getElementById('signup-email').value.trim();
    var username = document.getElementById('signup-username').value.trim();
    var password = document.getElementById('signup-password').value;
    if (!email || !username || !password) { showAuthError('Please fill in all fields'); return; }
    if (password.length < 6) { showAuthError('Password must be at least 6 characters'); return; }
    showLoading(); clearAuthError();
    fetch(API_BASE_URL + '/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, username: username, password: password })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
        hideLoading();
        if (res.ok) {
            authToken   = res.d.token;
            currentUser = res.d.user;
            localStorage.setItem('authToken',     authToken);
            localStorage.setItem('currentUser',   JSON.stringify(currentUser));
            showAppContainer();
            showSongSelection();
        } else {
            showAuthError(res.d.detail || 'Signup failed');
        }
    })
    .catch(function() { hideLoading(); showAuthError('Could not connect to server. Try again shortly.'); });
}

function login() {
    var email    = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    if (!email || !password) { showAuthError('Please fill in all fields'); return; }
    showLoading(); clearAuthError();
    fetch(API_BASE_URL + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
        hideLoading();
        if (res.ok) {
            authToken   = res.d.token;
            currentUser = res.d.user;
            localStorage.setItem('authToken',   authToken);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showAppContainer();
            loadUserSong();
        } else {
            showAuthError(res.d.detail || 'Login failed');
        }
    })
    .catch(function() { hideLoading(); showAuthError('Could not connect to server. Try again shortly.'); });
}

function logout() {
    authToken = null; currentUser = null; hasSong = false; currentSong = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    _stopTick();
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch(e) {} }
    ytPlayer = null;
    Ambient.reset();
    showAuthContainer();
}

// ── Song ──────────────────────────────────────────────────────
function loadUserSong() {
    showLoading();
    fetch(API_BASE_URL + '/user/song', {
        headers: { 'Authorization': 'Bearer ' + authToken }
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
        hideLoading();
        if (res.ok && res.d.has_song) {
            hasSong = true; currentSong = res.d.song;
            displaySong(res.d.song);
        } else {
            hasSong = false; showSongSelection();
        }
    })
    .catch(function() { hideLoading(); showSongSelection(); });
}

function saveSong() {
    var song_name   = document.getElementById('input-song-name').value.trim();
    var artist_name = document.getElementById('input-artist-name').value.trim();
    var youtube_url = document.getElementById('input-youtube-url').value.trim();
    if (!song_name || !artist_name || !youtube_url) {
        showFormError('Please fill in all three fields'); return;
    }
    if (youtube_url.indexOf('youtube.com') === -1 && youtube_url.indexOf('youtu.be') === -1) {
        showFormError('Please enter a valid YouTube URL'); return;
    }
    showLoading(); clearFormError();
    fetch(API_BASE_URL + '/user/song', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ song_name: song_name, artist_name: artist_name, youtube_url: youtube_url })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
        hideLoading();
        if (res.ok) {
            hasSong = true; currentSong = res.d.song;
            displaySong(res.d.song);
        } else {
            showFormError(res.d.detail || 'Failed to save song');
        }
    })
    .catch(function() { hideLoading(); showFormError('Could not connect to server. Try again shortly.'); });
}

// ── YouTube IFrame API ────────────────────────────────────────
function initYouTubePlayer(videoId) {
    // If API not loaded yet, load it and create player in callback
    if (!window.YT || !window.YT.Player) {
        window.onYouTubeIframeAPIReady = function() { _createPlayer(videoId); };
        if (!document.getElementById('yt-api-script')) {
            var tag = document.createElement('script');
            tag.id  = 'yt-api-script';
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
        }
    } else {
        _createPlayer(videoId);
    }
}

function _createPlayer(videoId) {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(e) {} ytPlayer = null; }
    document.getElementById('youtube-player').innerHTML = '<div id="yt-iframe-container"></div>';
    ytPlayer = new YT.Player('yt-iframe-container', {
        height: '100%', width: '100%',
        videoId: videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onStateChange: _onPlayerStateChange }
    });
}

function _onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        _startTick();
    } else {
        _stopTick();
        var t = (ytPlayer && ytPlayer.getCurrentTime) ? ytPlayer.getCurrentTime() : 0;
        Ambient.tickAudio(t, false);
    }
}

function _startTick() {
    _stopTick();
    _tickInterval = setInterval(function() {
        if (ytPlayer && ytPlayer.getCurrentTime) {
            Ambient.tickAudio(ytPlayer.getCurrentTime(), true);
        }
    }, 250);
}

function _stopTick() {
    if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}

// Spacebar tap-to-beat
document.addEventListener('keydown', function(e) {
    if (e.code === 'Space' && hasSong && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        Ambient.syncBeat();
        showToast('🥁 Beat synced!', '#c8a96e');
        setTimeout(hideToast, 1200);
    }
});

// ── Display ───────────────────────────────────────────────────
function displaySong(song) {
    document.getElementById('song-display').classList.remove('hidden');
    document.getElementById('song-selection').classList.add('hidden');
    document.getElementById('welcome-text').textContent = 'Hello, ' + currentUser.username;
    document.getElementById('song-name').textContent    = song.song_name;
    document.getElementById('song-artist').textContent  = song.artist_name;
    document.getElementById('sync-hint').classList.remove('hidden');
    document.getElementById('recommendations-section').classList.add('hidden');
    var recBtn = document.getElementById('rec-btn');
    recBtn.disabled    = false;
    recBtn.textContent = '✦ Get Song Recommendations';
    initYouTubePlayer(song.youtube_video_id);
    Ambient.setSong(song.song_name, song.artist_name, song.youtube_url, authToken);
}

function showSongSelection() {
    document.getElementById('song-display').classList.add('hidden');
    document.getElementById('song-selection').classList.remove('hidden');
    ['input-song-name', 'input-artist-name', 'input-youtube-url'].forEach(function(id) {
        document.getElementById(id).value = '';
    });
    document.getElementById('cancel-btn').style.display = hasSong ? 'block' : 'none';
    clearFormError();
}

function cancelSongSelection() {
    document.getElementById('song-selection').classList.add('hidden');
    document.getElementById('song-display').classList.remove('hidden');
}

// ── Recommendations ───────────────────────────────────────────
function getRecommendations() {
    if (!currentSong) return;
    var recBtn     = document.getElementById('rec-btn');
    var recSection = document.getElementById('recommendations-section');
    var recLoading = document.getElementById('rec-loading');
    var recError   = document.getElementById('rec-error');
    var recList    = document.getElementById('rec-list');

    recBtn.disabled    = true;
    recBtn.textContent = '✦ Finding matches...';
    recSection.classList.add('hidden');
    recError.classList.add('hidden');
    recLoading.classList.remove('hidden');

    fetch(API_BASE_URL + '/recommendations?track=' + encodeURIComponent(currentSong.song_name)
          + '&artist=' + encodeURIComponent(currentSong.artist_name), {
        headers: { 'Authorization': 'Bearer ' + authToken }
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
        recLoading.classList.add('hidden');
        recBtn.disabled = false;
        if (!res.ok) {
            recError.textContent = res.d.detail || 'Could not fetch recommendations.';
            recError.classList.remove('hidden'); return;
        }
        if (!res.d.tracks || !res.d.tracks.length) {
            recError.textContent = 'No similar songs found.';
            recError.classList.remove('hidden'); return;
        }
        recList.innerHTML = res.d.tracks.map(function(track) {
            var q = encodeURIComponent(track.name + ' ' + track.artist);
            return '<div class="rec-item">'
                + '<div class="rec-item-header">'
                + '<div class="rec-item-info">'
                + '<div class="rec-song-title">' + _esc(track.name) + '</div>'
                + '<div class="rec-artist">' + _esc(track.artist) + '</div>'
                + '</div>'
                + (track.match ? '<div class="rec-match">' + track.match + '% match</div>' : '')
                + '</div>'
                + '<div class="rec-reason">🎵 Recommended by Last.fm based on listener patterns.</div>'
                + '<div class="rec-links">'
                + '<a class="rec-search-link" href="https://www.youtube.com/results?search_query=' + q + '" target="_blank" rel="noopener">Search on YouTube →</a>'
                + '<a class="rec-search-link" href="' + _esc(track.url) + '" target="_blank" rel="noopener">View on Last.fm →</a>'
                + '</div></div>';
        }).join('');
        recSection.classList.remove('hidden');
        recBtn.textContent = '✦ Refresh Recommendations';
    })
    .catch(function() {
        recLoading.classList.add('hidden');
        recBtn.disabled = false;
        recError.textContent = 'Could not fetch recommendations. Check your connection.';
        recError.classList.remove('hidden');
    });
}

function _esc(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}