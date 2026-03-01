// ============================================================
// ambient.js
// WebGL fluid background renderer.
// Audio-reactive values come from gradientController.gfx —
// this file only owns the GPU pipeline and render loop.
// ============================================================

import { gfx, tick, setBasePalette, loadAudioData } from './gradientController.js';

const canvas = document.getElementById('bg-canvas');
const gl     = canvas.getContext('webgl');

// ── Internal render state ────────────────────────────────────
let _time       = 0;
let _mouseX     = 0.5, _mouseY = 0.5;
let _tgtMouseX  = 0.5, _tgtMouseY = 0.5;
let _playing    = false;
let _beatTimer  = null;   // interval handle for fallback metronome

// ── Shader config (not audio-driven) ────────────────────────
const CFG = { speed: 0.2, turb: 1.5, orbs: 3.0 };

// ── Default palette (overridden by Ambient.setSong) ─────────
let _currentPalette = [
    [0.05, 0.05, 0.1],
    [0.2,  0.5,  0.9],
    [0.01, 0.01, 0.05],
];
let _targetPalette = _currentPalette.map(c => [...c]);

// ── Mood palette map ─────────────────────────────────────────
const MOODS = {
    sad:        [[0.05,0.05,0.15],[0.2,0.3,0.6],[0.0,0.0,0.05]],
    happy:      [[0.8,0.3,0.1],[1.0,0.8,0.2],[0.4,0.0,0.1]],
    chill:      [[0.1,0.2,0.15],[0.4,0.8,0.6],[0.05,0.1,0.05]],
    electronic: [[0.1,0.0,0.2],[0.9,0.2,1.0],[0.0,0.0,0.1]],
};

// ── GLSL ─────────────────────────────────────────────────────
const VERT = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `
    precision highp float;

    uniform float u_time;
    uniform vec2  u_res;

    // Palette (hue-shifted by gradientController each frame)
    uniform vec3  u_c0, u_c1, u_c2;

    // Static shape config
    uniform float u_speed, u_turb, u_orbs;

    // Audio-reactive uniforms
    uniform float u_kick;       // beat pulse  (gradientController.gfx.pulse)
    uniform float u_intensity;  // brightness  (gfx.intensity)
    uniform float u_phase;      // drift offset (gfx.phase)
    uniform float u_bassFlow;   // vertical warp (gfx.bassFlow)

    // Mouse
    uniform vec2 u_mouse;

    // ── noise / fbm ──────────────────────────────────────────
    vec3 hash3(vec2 p) {
        vec3 q = vec3(dot(p,vec2(127.1,311.7)),
                      dot(p,vec2(269.5,183.3)),
                      dot(p,vec2(419.2,371.9)));
        return fract(sin(q)*43758.5453);
    }
    float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p);
        f = f*f*(3.0-2.0*f);
        float a=dot(hash3(i),            vec3(1,0,0));
        float b=dot(hash3(i+vec2(1,0)),  vec3(1,0,0));
        float c=dot(hash3(i+vec2(0,1)),  vec3(1,0,0));
        float d=dot(hash3(i+vec2(1,1)),  vec3(1,0,0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
    }
    float fbm(vec2 p) {
        float v=0.0, a=0.5;
        for(int i=0;i<5;i++){
            // Bass energy warps vertical frequency
            p.y *= 1.0 + u_bassFlow * 0.3;
            v += a*noise(p);
            p  = p*2.1 + vec2(1.7,9.2);
            a *= 0.5;
        }
        return v;
    }

    void main() {
        vec2 uv = gl_FragCoord.xy / u_res;
        uv.x   *= u_res.x / u_res.y;

        vec2 center    = vec2(0.5 * u_res.x / u_res.y, 0.5);
        vec2 toCenter  = normalize(uv - center);
        float dist     = length(uv - center);

        // ── Beat ripple ───────────────────────────────────────
        float rippleR = (1.0 - u_kick) * 1.5;
        float ring    = smoothstep(rippleR - 0.3, rippleR, dist)
                      - smoothstep(rippleR,       rippleR + 0.1, dist);
        float ripple  = ring * u_kick;
        uv += toCenter * ripple * 0.04;

        // ── Mouse repulsion ───────────────────────────────────
        vec2 mouseUv = vec2(u_mouse.x * u_res.x/u_res.y, u_mouse.y);
        vec2 toMouse = uv - mouseUv;
        float mDist  = length(toMouse);
        uv += normalize(toMouse) * smoothstep(0.4, 0.0, mDist) * 0.08;

        // ── Fluid generation using phase accumulator ──────────
        float t  = u_time * u_speed + u_phase * 0.1;
        vec2  q  = vec2(fbm(uv + t * 0.4), fbm(uv + vec2(5.2, 1.3)));
        vec2  r  = vec2(fbm(uv + u_turb*q + vec2(1.7,9.2) + t*0.15),
                        fbm(uv + u_turb*q + vec2(8.3,2.8) + t*0.12));
        float f  = fbm(uv + u_turb*r + t*0.1);

        // ── Orbiting glows ────────────────────────────────────
        float orbs = 0.0;
        for(float i=0.0; i<6.0; i++){
            if(i >= u_orbs) break;
            float fi    = i / max(u_orbs-1.0, 1.0);
            float angle = fi*6.2832 + t*(0.3+fi*0.2);
            float radius= (0.25+fi*0.18) * (1.0 + ripple*0.15);
            vec2  oc    = vec2(center.x + cos(angle)*radius,
                               0.5      + sin(angle)*radius*0.7);
            float d     = length(uv - oc);
            float pulse = 1.0 + 0.12*sin(t*6.2832 + fi*2.094);
            orbs += (0.06*pulse) / (d + 0.001);
        }

        // ── Colour mixing ─────────────────────────────────────
        vec3 col = mix(u_c0, u_c1, clamp(f*f*f*2.5 + orbs*0.3, 0.0, 1.0));
        col = mix(col, u_c2, clamp(length(q)*0.5 + orbs*0.15, 0.0, 1.0));

        // Beat glow
        col += u_c1 * ripple * 0.5;

        // Audio intensity modulates brightness
        col *= u_intensity;

        // Vignette
        vec2 vig = uv - center;
        col *= 1.0 - dot(vig, vig) * 0.6;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── WebGL setup ───────────────────────────────────────────────
function _compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

const _prog = gl.createProgram();
gl.attachShader(_prog, _compileShader(gl.VERTEX_SHADER,   VERT));
gl.attachShader(_prog, _compileShader(gl.FRAGMENT_SHADER, FRAG));
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
    kick:      gl.getUniformLocation(_prog, 'u_kick'),
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
window.addEventListener('mousemove', e => {
    _tgtMouseX = e.clientX / window.innerWidth;
    _tgtMouseY = 1.0 - (e.clientY / window.innerHeight);
});

// ── Palette helpers ───────────────────────────────────────────
function _lerpPalette() {
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            _currentPalette[i][j] += (_targetPalette[i][j] - _currentPalette[i][j]) * 0.02;
}

function _hashPalette(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash % 360) / 360;
    const h2r = (h, s, l) => {
        if (s === 0) return [l, l, l];
        const q  = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
        const hx = (p, q, t) => {
            if(t<0)t+=1; if(t>1)t-=1;
            if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q;
            if(t<2/3)return p+(q-p)*(2/3-t)*6; return p;
        };
        return [hx(p,q,h+1/3), hx(p,q,h), hx(p,q,h-1/3)];
    };
    return [h2r(hue,0.8,0.15), h2r((hue+0.1)%1,0.9,0.6), h2r((hue-0.1+1)%1,1.0,0.05)];
}

// ── Main render loop ──────────────────────────────────────────
function _render() {
    _time += 0.01;

    // Smooth mouse
    _mouseX += (_tgtMouseX - _mouseX) * 0.05;
    _mouseY += (_tgtMouseY - _mouseY) * 0.05;

    // Lerp palette toward target
    _lerpPalette();

    // Colours may be further hue-shifted by gradientController
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
    gl.uniform1f(U.kick,      gfx.pulse);
    gl.uniform1f(U.intensity, gfx.intensity);
    gl.uniform1f(U.phase,     gfx.phase);
    gl.uniform1f(U.bassFlow,  gfx.bassFlow);
    gl.uniform2f(U.mouse,     _mouseX, _mouseY);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(_render);
}

// ── Public Ambient API (called by app.js) ─────────────────────
export const Ambient = {
    /** Boot the render loop */
    init() { _render(); },

    /**
     * Called when a song is selected.
     * Fetches mood tags → sets palette, then fetches audio analysis → feeds gradientController.
     */
    async setSong(songName, artistName, youtubeUrl, authToken) {
        // 1. Mood palette
        try {
            const r = await fetch(
                `${window.API_BASE_URL}/mood?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`,
                { headers: { Authorization: `Bearer ${authToken}` } }
            );
            const { tags = [] } = await r.json();
            let palette = null;
            for (const tag of tags) {
                if (MOODS[tag]) { palette = MOODS[tag]; break; }
            }
            if (!palette) palette = _hashPalette(songName);
            _targetPalette = palette;
            // Tell gradientController the new base colours for hue-shifting
            setBasePalette(palette[1], palette[0]);
        } catch (e) {
            console.warn('[Ambient] mood fetch failed:', e);
            _targetPalette = _hashPalette(songName);
            setBasePalette(_targetPalette[1], _targetPalette[0]);
        }

        // 2. Audio analysis (yt-dlp + librosa on the backend)
        try {
            const r = await fetch(`${window.API_BASE_URL}/analyze/audio`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body:    JSON.stringify({ youtube_url: youtubeUrl }),
            });
            if (r.ok) {
                const data = await r.json();
                loadAudioData(data);
            } else {
                console.warn('[Ambient] audio analysis returned', r.status);
            }
        } catch (e) {
            console.warn('[Ambient] audio analysis failed:', e);
        }
    },

    /** Called every render frame by app.js with YT player current time */
    tickAudio(currentTime, isPlaying) {
        tick(currentTime, isPlaying);
    },

    /** Manual beat tap (Spacebar fallback) */
    syncBeat() {
        gfx.pulse = 1.0;
    },

    /** Reset to default state (logout / song change) */
    reset() {
        _targetPalette = [
            [0.05, 0.05, 0.1],
            [0.2,  0.5,  0.9],
            [0.01, 0.01, 0.05],
        ];
        gfx.pulse     = 0;
        gfx.phase     = 0;
        gfx.intensity = 1.0;
        gfx.bassFlow  = 0;
        setBasePalette([0.2,0.5,0.9], [0.05,0.05,0.1]);
    },
};