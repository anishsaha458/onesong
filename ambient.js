// ============================================================
// ambient.js  (classic script — load after gradientController.js)
//
// Three things this file owns:
//   1. WebGL fluid background shader
//   2. Video colour sampler — reads dominant hue from the YT
//      iframe every 2 s via a hidden canvas and feeds it as
//      the base palette
//   3. Render loop — calls GradientController.frame(dt) every
//      frame so beat decays are smooth at 60 fps
// ============================================================

const canvas = document.getElementById('bg-canvas');
const gl     = canvas.getContext('webgl');

// ── Static fluid config ───────────────────────────────────────
const CFG = { speed: 0.18, turb: 1.4, orbs: 3.0 };

// ── Palette lerp state ────────────────────────────────────────
// _currentPalette lerps toward _targetPalette each frame.
// Once video colour sampling kicks in, _targetPalette is replaced
// with the sampled colours — the transition is automatic.
let _currentPalette = [
    [0.05, 0.05, 0.1 ],   // c0  shadow / dark
    [0.2,  0.5,  0.9 ],   // c1  highlight / bright
    [0.01, 0.01, 0.05],   // c2  deep shadow
];
let _targetPalette = _currentPalette.map(c => [...c]);

// Mood fallback palette map (used if Last.fm returns a known tag)
const MOODS = {
    sad:        [[0.04,0.04,0.14],[0.18,0.28,0.58],[0.0,0.0,0.04]],
    happy:      [[0.7,0.25,0.05],[0.98,0.75,0.15],[0.35,0.0,0.08]],
    chill:      [[0.08,0.18,0.12],[0.35,0.75,0.55],[0.04,0.09,0.04]],
    electronic: [[0.08,0.0,0.18],[0.85,0.15,0.95],[0.0,0.0,0.08]],
    romantic:   [[0.18,0.04,0.08],[0.85,0.3,0.4],[0.08,0.0,0.04]],
    dark:       [[0.02,0.02,0.04],[0.25,0.1,0.35],[0.0,0.0,0.02]],
};

// ── GLSL shaders ─────────────────────────────────────────────
const VERT = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// Fragment shader: graceful fluid with TWO expanding ripple rings
const FRAG = `
precision highp float;

uniform float u_time;
uniform vec2  u_res;
uniform vec3  u_c0, u_c1, u_c2;
uniform float u_speed, u_turb, u_orbs;

// Audio-reactive
uniform float u_pulse;      // primary beat ring   (0-1, decays each frame)
uniform float u_pulse2;     // secondary beat ring (0-1, offset timing)
uniform float u_intensity;  // brightness from loudness
uniform float u_phase;      // tempo-driven phase accumulator
uniform float u_bassFlow;   // bass-driven vertical warp (0-1)

uniform vec2  u_mouse;

// ── Noise / FBM ──────────────────────────────────────────────
vec3 hash3(vec2 p) {
    vec3 q = vec3(dot(p,vec2(127.1,311.7)),
                  dot(p,vec2(269.5,183.3)),
                  dot(p,vec2(419.2,371.9)));
    return fract(sin(q)*43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float a = dot(hash3(i),           vec3(1,0,0));
    float b = dot(hash3(i+vec2(1,0)), vec3(1,0,0));
    float c = dot(hash3(i+vec2(0,1)), vec3(1,0,0));
    float d = dot(hash3(i+vec2(1,1)), vec3(1,0,0));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    // Bass energy stretches the vertical frequency of each octave,
    // producing elegant upward surges on low-end hits
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p  = p * 2.1 + vec2(1.7, 9.2);
        p.y *= 1.0 + u_bassFlow * 0.25;
        a *= 0.5;
    }
    return v;
}

// ── Graceful expanding ring ───────────────────────────────────
// Returns brightness of the ring at distance d from centre.
// radius grows from 0 → maxR as pulse decays 1 → 0.
// Width is narrow so it reads as a crisp ripple in water.
float ring(float dist, float pulse, float speed, float maxR) {
    if (pulse < 0.001) return 0.0;
    float r     = (1.0 - pulse) * maxR * speed;
    float width = 0.04 + (1.0 - pulse) * 0.06; // widens as it travels
    float edge  = smoothstep(r - width, r, dist)
                - smoothstep(r, r + width * 0.5, dist);
    return edge * pulse * pulse; // quadratic so leading edge is sharp
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    uv.x   *= u_res.x / u_res.y;

    vec2 center   = vec2(0.5 * u_res.x / u_res.y, 0.5);
    vec2 toCenter = uv - center;
    float dist    = length(toCenter);

    // ── Two concentric ripple rings ───────────────────────────
    float r1 = ring(dist, u_pulse,  1.0, 1.6);   // primary  — travels fast
    float r2 = ring(dist, u_pulse2, 0.7, 1.2);   // secondary — slower, softer
    float rippleTotal = r1 + r2 * 0.6;

    // Displace UV outward along the rings (gives the water-ripple feel)
    vec2 rippleDir = normalize(toCenter + vec2(0.001));
    uv += rippleDir * (r1 * 0.035 + r2 * 0.02);

    // ── Mouse soft repulsion ──────────────────────────────────
    vec2 mouseUv  = vec2(u_mouse.x * u_res.x / u_res.y, u_mouse.y);
    vec2 toMouse  = uv - mouseUv;
    float mDist   = length(toMouse);
    uv += normalize(toMouse + vec2(0.001)) * smoothstep(0.35, 0.0, mDist) * 0.06;

    // ── Fluid field ───────────────────────────────────────────
    // u_phase accumulates at tempo speed so motion always feels
    // "in time" with the track even before audio analysis completes
    float t  = u_time * u_speed + u_phase * 0.08;
    vec2  q  = vec2(fbm(uv + t * 0.35), fbm(uv + vec2(5.2, 1.3)));
    vec2  r  = vec2(fbm(uv + u_turb*q + vec2(1.7, 9.2) + t*0.14),
                    fbm(uv + u_turb*q + vec2(8.3, 2.8) + t*0.11));
    float f  = fbm(uv + u_turb*r + t*0.09);

    // ── Orbiting glow orbs ────────────────────────────────────
    float orbs = 0.0;
    for (float i = 0.0; i < 6.0; i++) {
        if (i >= u_orbs) break;
        float fi    = i / max(u_orbs - 1.0, 1.0);
        float angle = fi * 6.2832 + t * (0.25 + fi * 0.18);
        float rad   = (0.22 + fi * 0.16) * (1.0 + rippleTotal * 0.12);
        vec2  oc    = vec2(center.x + cos(angle) * rad,
                           0.5      + sin(angle) * rad * 0.65);
        // Gentle breathing pulse on each orb
        float breath = 1.0 + 0.1 * sin(t * 6.2832 + fi * 2.094);
        orbs += (0.055 * breath) / (length(uv - oc) + 0.001);
    }

    // ── Colour composition ────────────────────────────────────
    // Three-way mix driven by the fluid field and orb contribution
    float blend1 = clamp(f*f*f*2.2 + orbs*0.28, 0.0, 1.0);
    float blend2 = clamp(length(q)*0.45 + orbs*0.12, 0.0, 1.0);

    vec3 col = mix(u_c0, u_c1, blend1);
    col      = mix(col,  u_c2, blend2);

    // Ripple rings add a bright flash of the highlight colour
    col += u_c1 * rippleTotal * 0.55;

    // Loudness multiplies overall brightness
    col *= u_intensity;

    // Soft vignette — keeps edges dark, centre luminous
    float vig = dot(toCenter, toCenter);
    col *= 1.0 - vig * 0.55;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ── WebGL setup ───────────────────────────────────────────────
function _compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[Ambient] shader error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

const _prog = gl.createProgram();
gl.attachShader(_prog, _compile(gl.VERTEX_SHADER,   VERT));
gl.attachShader(_prog, _compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(_prog);
gl.useProgram(_prog);

const _buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, _buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const _posLoc = gl.getAttribLocation(_prog, 'position');
gl.enableVertexAttribArray(_posLoc);
gl.vertexAttribPointer(_posLoc, 2, gl.FLOAT, false, 0, 0);

const U = {
    time:      gl.getUniformLocation(_prog, 'u_time'),
    res:       gl.getUniformLocation(_prog, 'u_res'),
    c0:        gl.getUniformLocation(_prog, 'u_c0'),
    c1:        gl.getUniformLocation(_prog, 'u_c1'),
    c2:        gl.getUniformLocation(_prog, 'u_c2'),
    speed:     gl.getUniformLocation(_prog, 'u_speed'),
    turb:      gl.getUniformLocation(_prog, 'u_turb'),
    orbs:      gl.getUniformLocation(_prog, 'u_orbs'),
    pulse:     gl.getUniformLocation(_prog, 'u_pulse'),
    pulse2:    gl.getUniformLocation(_prog, 'u_pulse2'),
    intensity: gl.getUniformLocation(_prog, 'u_intensity'),
    phase:     gl.getUniformLocation(_prog, 'u_phase'),
    bassFlow:  gl.getUniformLocation(_prog, 'u_bassFlow'),
    mouse:     gl.getUniformLocation(_prog, 'u_mouse'),
};

// ── Resize ────────────────────────────────────────────────────
function _resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', _resize);
_resize();

// ── Mouse ─────────────────────────────────────────────────────
let _mouseX = 0.5, _mouseY = 0.5, _tgtX = 0.5, _tgtY = 0.5;
window.addEventListener('mousemove', e => {
    _tgtX = e.clientX / window.innerWidth;
    _tgtY = 1.0 - (e.clientY / window.innerHeight);
});

// ── Palette helpers ───────────────────────────────────────────
function _lerpPalette() {
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            _currentPalette[i][j] +=
                (_targetPalette[i][j] - _currentPalette[i][j]) * 0.025;
}

function _hashPalette(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
    const hue = Math.abs(h % 360) / 360;
    const hx  = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q-p)*6*t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q-p)*(2/3-t)*6;
        return p;
    };
    const h2r = (h, s, l) => {
        const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
        return [hx(p,q,h+1/3), hx(p,q,h), hx(p,q,h-1/3)];
    };
    return [
        h2r(hue,              0.8, 0.12),
        h2r((hue + 0.1) % 1, 0.9, 0.58),
        h2r((hue - 0.1+1)%1, 1.0, 0.04),
    ];
}

// ── Video colour sampler ──────────────────────────────────────
// Draws the YouTube iframe into a tiny off-screen canvas every
// 2 seconds, reads the pixel data, computes the average RGB,
// and maps that onto a graceful 3-tone palette.
// Falls back silently if CORS blocks the draw (common in iframes).

let _sampleCanvas = null;
let _sampleCtx    = null;
let _sampleTimer  = null;

function _startVideoSampling() {
    if (_sampleCanvas) return; // already running
    _sampleCanvas = document.createElement('canvas');
    _sampleCanvas.width  = 32;
    _sampleCanvas.height = 18;
    _sampleCtx = _sampleCanvas.getContext('2d');

    _sampleTimer = setInterval(_sampleVideoColour, 2000);
}

function _stopVideoSampling() {
    if (_sampleTimer) { clearInterval(_sampleTimer); _sampleTimer = null; }
    _sampleCanvas = null;
    _sampleCtx    = null;
}

function _sampleVideoColour() {
    // The YT iframe is inside #yt-iframe-container > iframe
    const container = document.getElementById('yt-iframe-container');
    if (!container) return;
    const iframe = container.querySelector('iframe');
    if (!iframe) return;

    try {
        // drawImage on a cross-origin iframe will throw a SecurityError.
        // We catch it and fall back to the hash palette — no crash.
        _sampleCtx.drawImage(iframe, 0, 0, 32, 18);
        const pixels = _sampleCtx.getImageData(0, 0, 32, 18).data;

        let r = 0, g = 0, b = 0, count = 0;
        // Sample every 4th pixel (skip alpha) for speed
        for (let i = 0; i < pixels.length; i += 16) {
            r += pixels[i];
            g += pixels[i+1];
            b += pixels[i+2];
            count++;
        }
        r /= count * 255;
        g /= count * 255;
        b /= count * 255;

        // Build a 3-tone palette from the dominant video colour:
        //   c0  = dark version  (shadow)
        //   c1  = vivid version (highlight)
        //   c2  = deep shadow
        const scale   = v => Math.min(1, Math.max(0, v));
        const bright  = [scale(r*2.2), scale(g*2.2), scale(b*2.2)];
        const mid     = [scale(r*0.9), scale(g*0.9), scale(b*0.9)];
        const dark    = [scale(r*0.15), scale(g*0.15), scale(b*0.15)];
        const deepDark= [scale(r*0.06), scale(g*0.06), scale(b*0.06)];

        _targetPalette = [dark, bright, deepDark];
        GradientController.setBasePalette(bright, mid);

    } catch (e) {
        // CORS block — silently ignore, keep current palette
    }
}

// ── Render loop ───────────────────────────────────────────────
let _time    = 0;
let _lastRAF = null;

function _render(now) {
    // Delta time in seconds, clamped to avoid huge jumps on tab switch
    const dt = _lastRAF ? Math.min((now - _lastRAF) / 1000, 0.05) : 0.016;
    _lastRAF = now;
    _time   += dt;

    // Advance audio-reactive state at 60fps
    GradientController.frame(dt);

    // Smooth mouse
    _mouseX += (_tgtX - _mouseX) * 0.06;
    _mouseY += (_tgtY - _mouseY) * 0.06;

    // Lerp palette toward target
    _lerpPalette();

    const gfx = GradientController.gfx;

    // Colours: GradientController provides hue-shifted versions;
    // fall back to lerped palette if no audio data is loaded yet.
    const c0 = gfx.bottomColor || _currentPalette[0];
    const c1 = gfx.topColor    || _currentPalette[1];
    const c2 = _currentPalette[2];

    gl.uniform1f(U.time,      _time);
    gl.uniform2f(U.res,       canvas.width, canvas.height);
    gl.uniform3fv(U.c0,       c0);
    gl.uniform3fv(U.c1,       c1);
    gl.uniform3fv(U.c2,       c2);
    gl.uniform1f(U.speed,     CFG.speed);
    gl.uniform1f(U.turb,      CFG.turb);
    gl.uniform1f(U.orbs,      CFG.orbs);
    gl.uniform1f(U.pulse,     gfx.pulse);
    gl.uniform1f(U.pulse2,    gfx.pulse2);
    gl.uniform1f(U.intensity, gfx.intensity);
    gl.uniform1f(U.phase,     gfx.phase);
    gl.uniform1f(U.bassFlow,  gfx.bassFlow);
    gl.uniform2f(U.mouse,     _mouseX, _mouseY);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(_render);
}

// ── Public API ────────────────────────────────────────────────
const Ambient = {

    init() {
        requestAnimationFrame(_render);
    },

    /**
     * Called by app.js when a song is loaded.
     * 1. Fetches Last.fm mood tags → sets initial palette
     * 2. Starts video colour sampling immediately (updates every 2s)
     * 3. Kicks off audio analysis in background (may take 20-60s)
     */
    async setSong(songName, artistName, youtubeUrl, authToken) {
        const API = 'https://onesong.onrender.com';

        // ── Step 1: Mood palette (instant fallback) ───────────
        try {
            const r = await fetch(
                `${API}/mood?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`,
                { headers: { Authorization: `Bearer ${authToken}` } }
            );
            const { tags = [] } = await r.json();
            let palette = null;
            for (const tag of tags) {
                if (MOODS[tag]) { palette = MOODS[tag]; break; }
            }
            if (!palette) palette = _hashPalette(songName);
            _targetPalette = palette;
            GradientController.setBasePalette(palette[1], palette[0]);
        } catch (e) {
            const p = _hashPalette(songName);
            _targetPalette = p;
            GradientController.setBasePalette(p[1], p[0]);
        }

        // ── Step 2: Start sampling video frame colours ─────────
        // Give the YT player 1.5s to render before first sample
        setTimeout(_startVideoSampling, 1500);

        // ── Step 3: Audio analysis (non-blocking) ─────────────
        try {
            const toastFn = window.showToast || (() => {});
            const hideFn  = window.hideToast  || (() => {});
            toastFn('🎵 Analysing audio…', '#a78bfa', true);

            const r = await fetch(`${API}/analyze/audio`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json',
                           Authorization: `Bearer ${authToken}` },
                body:    JSON.stringify({ youtube_url: youtubeUrl }),
            });
            hideFn();
            if (r.ok) {
                GradientController.loadAudioData(await r.json());
                toastFn('✓ Visuals synced to audio', '#4ade80');
                setTimeout(hideFn, 2500);
            }
        } catch (e) {
            if (window.hideToast) window.hideToast();
            console.warn('[Ambient] audio analysis unavailable — using spacebar sync');
        }
    },

    /**
     * Called by app.js every 250ms with YT player current time.
     * Delegates entirely to GradientController.updatePlayhead().
     */
    tickAudio(currentTime, isPlaying) {
        GradientController.updatePlayhead(currentTime, isPlaying);
        if (isPlaying) _startVideoSampling();
    },

    /** Manual beat tap — spacebar fallback */
    syncBeat() {
        GradientController.triggerBeat();
    },

    /** Stop video sampling and reset all visual state */
    reset() {
        _stopVideoSampling();
        _targetPalette = [
            [0.05, 0.05, 0.1 ],
            [0.2,  0.5,  0.9 ],
            [0.01, 0.01, 0.05],
        ];
        GradientController.reset();
    },
};