// ============================================================
// app.js
// Application logic: auth, song CRUD, YouTube player, UI state.
// Audio-reactive visual work is delegated to ambient.js /
// gradientController.js — this file only coordinates them.
// ============================================================

import { Ambient } from './ambient.js';

export const API_BASE_URL = 'https://onesong.onrender.com';
window.API_BASE_URL = API_BASE_URL;   // ambient.js needs this too

// ── App state ─────────────────────────────────────────────────
let currentUser = null;
let authToken   = null;
let hasSong     = false;
let currentSong = null;
let serverReady = false;
let ytPlayer    = null;
let _tickInterval = null;   // polls YT player time → Ambient.tickAudio

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, color = '#a78bfa', spin = false) {
    let el = document.getElementById('wake-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'wake-toast';
        el.style.cssText = `
            position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
            background:#17171a;border:1px solid ${color};color:#f0ede8;
            padding:12px 20px;border-radius:12px;
            font-family:'DM Sans',sans-serif;font-size:14px;
            display:flex;align-items:center;gap:10px;
            box-shadow:0 8px 32px rgba(0,0,0,0.5);z-index:10000;
            transition:opacity 0.4s;white-space:nowrap;`;
        document.body.appendChild(el);
    }
    el.style.borderColor = color;
    el.style.opacity = '1';
    el.innerHTML = (spin
        ? `<div style="width:13px;height:13px;border:2px solid rgba(167,139,250,0.25);border-top-color:${color};border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div>`
        : '') + `<span>${msg}</span>`;
    el.style.display = 'flex';
}
function hideToast() {
    const el = document.getElementById('wake-toast');
    if (el) { el.style.opacity = '0'; setTimeout(() => el && (el.style.display='none'), 400); }
}

// ── Server wake-up ────────────────────────────────────────────
async function pingServer() {
    try {
        const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(65000) });
        if (res.ok) {
            serverReady = true;
            showToast('✓ Server ready', '#4ade80');
            setTimeout(hideToast, 2000);
            return true;
        }
    } catch {
        showToast('⚠ Server offline — try refreshing in 30s', '#e57373');
    }
    return false;
}

// ── Recommendations (Last.fm) ─────────────────────────────────
async function getRecommendations() {
    if (!currentSong) return;
    const recBtn     = document.getElementById('rec-btn');
    const recSection = document.getElementById('recommendations-section');
    const recLoading = document.getElementById('rec-loading');
    const recError   = document.getElementById('rec-error');
    const recList    = document.getElementById('rec-list');

    recBtn.disabled = true;
    recBtn.textContent = '✦ Finding matches...';
    recSection.classList.add('hidden');
    recError.classList.add('hidden');
    recLoading.classList.remove('hidden');

    try {
        const res = await fetch(
            `${API_BASE_URL}/recommendations?track=${encodeURIComponent(currentSong.song_name)}&artist=${encodeURIComponent(currentSong.artist_name)}`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );
        const data = await res.json();
        if (!res.ok) { recError.textContent = data.detail || 'Could not fetch recommendations.'; recError.classList.remove('hidden'); return; }
        if (!data.tracks?.length) { recError.textContent = 'No similar songs found for this track.'; recError.classList.remove('hidden'); return; }

        recList.innerHTML = data.tracks.map(track => {
            const q = encodeURIComponent(`${track.name} ${track.artist}`);
            return `
            <div class="rec-item">
              <div class="rec-item-header">
                <div class="rec-item-info">
                  <div class="rec-song-title">${escapeHtml(track.name)}</div>
                  <div class="rec-artist">${escapeHtml(track.artist)}</div>
                </div>
                ${track.match !== null ? `<div class="rec-match">${track.match}% match</div>` : ''}
              </div>
              <div class="rec-reason">🎵 Recommended by Last.fm based on listener patterns.</div>
              <div class="rec-links">
                <a class="rec-search-link" href="https://www.youtube.com/results?search_query=${q}" target="_blank" rel="noopener">Search on YouTube →</a>
                <a class="rec-search-link" href="${escapeHtml(track.url)}" target="_blank" rel="noopener">View on Last.fm →</a>
              </div>
            </div>`;
        }).join('');
        recSection.classList.remove('hidden');
        recBtn.textContent = '✦ Refresh Recommendations';
    } catch {
        recError.textContent = 'Could not fetch recommendations. Check your connection.';
        recError.classList.remove('hidden');
    } finally {
        recLoading.classList.add('hidden');
        recBtn.disabled = false;
    }
}
window.getRecommendations = getRecommendations;

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auth ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    Ambient.init();
    showToast('⏳ Waking up server…', '#a78bfa', true);
    pingServer().then(() => checkAuth());
});

function checkAuth() {
    authToken = localStorage.getItem('authToken');
    const userStr = localStorage.getItem('currentUser');
    if (authToken && userStr) { currentUser = JSON.parse(userStr); verifyToken(); }
    else showAuthContainer();
}

async function verifyToken() {
    try {
        const r = await fetch(`${API_BASE_URL}/auth/verify`, { headers: { Authorization: `Bearer ${authToken}` } });
        if (r.ok) { showAppContainer(); loadUserSong(); } else logout();
    } catch { logout(); }
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

window.showSignup = () => { document.getElementById('login-form').classList.add('hidden');  document.getElementById('signup-form').classList.remove('hidden'); clearAuthError(); };
window.showLogin  = () => { document.getElementById('signup-form').classList.add('hidden'); document.getElementById('login-form').classList.remove('hidden');  clearAuthError(); };

function showAuthError(msg) { const el = document.getElementById('auth-error'); el.textContent = msg; el.classList.remove('hidden'); }
function clearAuthError()   { document.getElementById('auth-error').classList.add('hidden'); }
function showFormError(msg) { const el = document.getElementById('song-form-error'); el.textContent = msg; el.classList.remove('hidden'); }
function clearFormError()   { document.getElementById('song-form-error').classList.add('hidden'); }

window.signup = async function() {
    const email    = document.getElementById('signup-email').value.trim();
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;
    if (!email||!username||!password) { showAuthError('Please fill in all fields'); return; }
    if (password.length < 6)          { showAuthError('Password must be at least 6 characters'); return; }
    showLoading(); clearAuthError();
    try {
        const r = await fetch(`${API_BASE_URL}/auth/signup`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email,username,password}) });
        const d = await r.json();
        if (r.ok) { authToken=d.token; currentUser=d.user; localStorage.setItem('authToken',authToken); localStorage.setItem('currentUser',JSON.stringify(currentUser)); showAppContainer(); showSongSelection(); }
        else showAuthError(d.detail || 'Signup failed');
    } catch { showAuthError('Could not connect to server. Try again shortly.'); }
    finally { hideLoading(); }
};

window.login = async function() {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email||!password) { showAuthError('Please fill in all fields'); return; }
    showLoading(); clearAuthError();
    try {
        const r = await fetch(`${API_BASE_URL}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email,password}) });
        const d = await r.json();
        if (r.ok) { authToken=d.token; currentUser=d.user; localStorage.setItem('authToken',authToken); localStorage.setItem('currentUser',JSON.stringify(currentUser)); showAppContainer(); loadUserSong(); }
        else showAuthError(d.detail || 'Login failed');
    } catch { showAuthError('Could not connect to server. Try again shortly.'); }
    finally { hideLoading(); }
};

window.logout = function() {
    authToken=null; currentUser=null; hasSong=false; currentSong=null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    _stopTick();
    if (ytPlayer?.destroy) ytPlayer.destroy();
    Ambient.reset();
    showAuthContainer();
};

async function loadUserSong() {
    showLoading();
    try {
        const r = await fetch(`${API_BASE_URL}/user/song`, { headers:{ Authorization:`Bearer ${authToken}` } });
        const d = await r.json();
        if (r.ok && d.has_song) { hasSong=true; currentSong=d.song; displaySong(d.song); }
        else { hasSong=false; showSongSelection(); }
    } catch { showSongSelection(); }
    finally { hideLoading(); }
}

// ── YouTube IFrame API ────────────────────────────────────────

/**
 * Loads the YT IFrame API (once) then creates the player.
 * After the player is ready, a 250ms tick interval drives Ambient.tickAudio.
 */
function initYouTubePlayer(videoId) {
    if (!window.YT) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
        window.onYouTubeIframeAPIReady = () => _createPlayer(videoId);
    } else {
        _createPlayer(videoId);
    }
}

function _createPlayer(videoId) {
    if (ytPlayer) ytPlayer.destroy();
    document.getElementById('youtube-player').innerHTML = '<div id="yt-iframe-container"></div>';
    ytPlayer = new YT.Player('yt-iframe-container', {
        height: '100%', width: '100%', videoId,
        playerVars: { rel:0, modestbranding:1, playsinline:1 },
        events: { onStateChange: _onPlayerStateChange },
    });
}

function _onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        _startTick();
    } else {
        _stopTick();
        Ambient.tickAudio(0, false);
    }
}

/** Poll the YT player every 250ms and push current time to gradientController */
function _startTick() {
    _stopTick();
    _tickInterval = setInterval(() => {
        if (ytPlayer?.getCurrentTime) {
            Ambient.tickAudio(ytPlayer.getCurrentTime(), true);
        }
    }, 250);
}
function _stopTick() {
    if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}

// ── Spacebar beat tap ─────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.code === 'Space' && hasSong && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        Ambient.syncBeat();
        showToast('🥁 Beat synced!', '#c8a96e');
        setTimeout(hideToast, 1200);
    }
});

// ── Song display & selection ──────────────────────────────────
function displaySong(song) {
    document.getElementById('song-display').classList.remove('hidden');
    document.getElementById('song-selection').classList.add('hidden');
    document.getElementById('welcome-text').textContent = `Hello, ${currentUser.username}`;
    document.getElementById('song-name').textContent   = song.song_name;
    document.getElementById('song-artist').textContent = song.artist_name;

    initYouTubePlayer(song.youtube_video_id);
    document.getElementById('sync-hint').classList.remove('hidden');

    // Reset recommendations UI
    document.getElementById('recommendations-section').classList.add('hidden');
    const recBtn = document.getElementById('rec-btn');
    recBtn.disabled = false;
    recBtn.textContent = '✦ Get Song Recommendations';

    // Kick off ambient: palette + audio analysis
    Ambient.setSong(song.song_name, song.artist_name, song.youtube_url, authToken);
}

window.showSongSelection = function() {
    document.getElementById('song-display').classList.add('hidden');
    document.getElementById('song-selection').classList.remove('hidden');
    ['input-song-name','input-artist-name','input-youtube-url'].forEach(id => document.getElementById(id).value='');
    document.getElementById('cancel-btn').style.display = hasSong ? 'block' : 'none';
    clearFormError();
};

window.cancelSongSelection = function() {
    document.getElementById('song-selection').classList.add('hidden');
    document.getElementById('song-display').classList.remove('hidden');
};

window.saveSong = async function() {
    const song_name    = document.getElementById('input-song-name').value.trim();
    const artist_name  = document.getElementById('input-artist-name').value.trim();
    const youtube_url  = document.getElementById('input-youtube-url').value.trim();
    if (!song_name||!artist_name||!youtube_url) { showFormError('Please fill in all three fields'); return; }
    if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) { showFormError('Please enter a valid YouTube URL'); return; }
    showLoading(); clearFormError();
    try {
        const r = await fetch(`${API_BASE_URL}/user/song`, {
            method:'PUT',
            headers:{ Authorization:`Bearer ${authToken}`, 'Content-Type':'application/json' },
            body: JSON.stringify({song_name, artist_name, youtube_url}),
        });
        const d = await r.json();
        if (r.ok) { hasSong=true; currentSong=d.song; displaySong(d.song); }
        else showFormError(d.detail || 'Failed to save song');
    } catch { showFormError('Could not connect to server. Try again shortly.'); }
    finally { hideLoading(); }
};