// ============================================================
// ambient.js  (classic script — load after gradientController.js)
//
// Owns:
//   1. WebGL fluid background shader — graceful ripples, bass warp
//   2. Colour sampler — reads dominant hue from the YouTube
//      video THUMBNAIL (CORS-safe, unlike the iframe itself)
//      and smoothly transitions the palette to match
//   3. Render loop — calls GradientController.frame(dt) every
//      frame so all decays are smooth at 60 fps
// ============================================================

const canvas = document.getElementById('bg-canvas');
const gl     = canvas.getContext('webgl');

// ── Static fluid config ───────────────────────────────────────
const CFG = { speed: 0.18, turb: 1.4, orbs: 3.0 };

// ── Palette lerp state ────────────────────────────────────────
let _currentPalette = [
    [0.05, 0.05, 0.1 ],
    [0.2,  0.5,  0.9 ],
    [0.01, 0.01, 0.05],
];
let _targetPalette = _currentPalette.map(c => [...c]);

const MOODS = {
    sad:        [[0.04,0.04,0.14],[0.18,0.28,0.58],[0.0,0.0,0.04]],
    happy:      [[0.7,0.25,0.05],[0.98,0.75,0.15],[0.35,0.0,0.08]],
    chill:      [[0.08,0.18,0.12],[0.35,0.75,0.55],[0.04,0.09,0.04]],
    electronic: [[0.08,0.0,0.18],[0.85,0.15,0.95],[0.0,0.0,0.08]],
    romantic:   [[0.18,0.04,0.08],[0.85,0.3,0.4],[0.08,0.0,0.04]],
    dark:       [[0.02,0.02,0.04],[0.25,0.1,0.35],[0.0,0.0,0.02]],
};

// ── GLSL ──────────────────────────────────────────────────────
const VERT = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform float u_time;
uniform vec2  u_res;
uniform vec3  u_c0, u_c1, u_c2;
uniform float u_speed, u_turb, u_orbs;
uniform float u_pulse;
uniform float u_pulse2;
uniform float u_intensity;
uniform float u_phase;
uniform float u_bassFlow;
uniform vec2  u_mouse;

vec3 hash3(vec2 p) {
    vec3 q = vec3(dot(p,vec2(127.1,311.7)),
                  dot(p,vec2(269.5,183.3)),
                  dot(p,vec2(419.2,371.9)));
    return fract(sin(q)*43758.5453);
}
float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=dot(hash3(i),vec3(1,0,0));
    float b=dot(hash3(i+vec2(1,0)),vec3(1,0,0));
    float c=dot(hash3(i+vec2(0,1)),vec3(1,0,0));
    float d=dot(hash3(i+vec2(1,1)),vec3(1,0,0));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float fbm(vec2 p) {
    float v=0.0, a=0.5;
    for (int i=0;i<5;i++) {
        v += a*noise(p);
        p  = p*2.1+vec2(1.7,9.2);
        p.y *= 1.0 + u_bassFlow*0.25;
        a  *= 0.5;
    }
    return v;
}

// Graceful expanding ring — narrows at edges like water ripple
float ring(float dist, float pulse, float speed, float maxR) {
    if (pulse < 0.001) return 0.0;
    float r     = (1.0-pulse)*maxR*speed;
    float width = 0.03 + (1.0-pulse)*0.05;
    float edge  = smoothstep(r-width, r, dist)
                - smoothstep(r, r+width*0.6, dist);
    return edge * pulse * pulse;
}

void main() {
    vec2 uv = gl_FragCoord.xy/u_res;
    uv.x   *= u_res.x/u_res.y;
    vec2 center   = vec2(0.5*u_res.x/u_res.y, 0.5);
    vec2 toCenter = uv - center;
    float dist    = length(toCenter);

    // Two concentric rings — primary fast, secondary soft & slower
    float r1 = ring(dist, u_pulse,  1.0, 1.6);
    float r2 = ring(dist, u_pulse2, 0.65, 1.1);
    float rippleTotal = r1 + r2*0.55;

    vec2 rDir = normalize(toCenter + vec2(0.001));
    uv += rDir * (r1*0.032 + r2*0.018);

    // Soft mouse repulsion
    vec2 mouseUv = vec2(u_mouse.x*u_res.x/u_res.y, u_mouse.y);
    vec2 toMouse = uv - mouseUv;
    uv += normalize(toMouse+vec2(0.001)) * smoothstep(0.35,0.0,length(toMouse)) * 0.06;

    // Fluid field driven by phase accumulator
    float t  = u_time*u_speed + u_phase*0.08;
    vec2  q  = vec2(fbm(uv+t*0.35), fbm(uv+vec2(5.2,1.3)));
    vec2  r  = vec2(fbm(uv+u_turb*q+vec2(1.7,9.2)+t*0.14),
                    fbm(uv+u_turb*q+vec2(8.3,2.8)+t*0.11));
    float f  = fbm(uv+u_turb*r+t*0.09);

    // Orbiting glows
    float orbs=0.0;
    for (float i=0.0;i<6.0;i++) {
        if (i>=u_orbs) break;
        float fi    = i/max(u_orbs-1.0,1.0);
        float angle = fi*6.2832 + t*(0.25+fi*0.18);
        float rad   = (0.22+fi*0.16)*(1.0+rippleTotal*0.12);
        vec2  oc    = vec2(center.x+cos(angle)*rad, 0.5+sin(angle)*rad*0.65);
        float breath= 1.0+0.1*sin(t*6.2832+fi*2.094);
        orbs += (0.055*breath)/(length(uv-oc)+0.001);
    }

    vec3 col = mix(u_c0, u_c1, clamp(f*f*f*2.2+orbs*0.28,0.0,1.0));
    col      = mix(col,  u_c2, clamp(length(q)*0.45+orbs*0.12,0.0,1.0));
    col += u_c1 * rippleTotal * 0.55;
    col *= u_intensity;
    col *= 1.0 - dot(toCenter,toCenter)*0.55;
    gl_FragColor = vec4(clamp(col,0.0,1.0),1.0);
}
`;

// ── WebGL boilerplate ─────────────────────────────────────────
function _compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[Ambient] shader compile error:', gl.getShaderInfoLog(s));
        return null;
    }
    return s;
}
const _prog = gl.createProgram();
gl.attachShader(_prog, _compile(gl.VERTEX_SHADER,   VERT));
gl.attachShader(_prog, _compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(_prog); gl.useProgram(_prog);

const _buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, _buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
const _posLoc = gl.getAttribLocation(_prog, 'position');
gl.enableVertexAttribArray(_posLoc);
gl.vertexAttribPointer(_posLoc, 2, gl.FLOAT, false, 0, 0);

const U = {
    time:      gl.getUniformLocation(_prog,'u_time'),
    res:       gl.getUniformLocation(_prog,'u_res'),
    c0:        gl.getUniformLocation(_prog,'u_c0'),
    c1:        gl.getUniformLocation(_prog,'u_c1'),
    c2:        gl.getUniformLocation(_prog,'u_c2'),
    speed:     gl.getUniformLocation(_prog,'u_speed'),
    turb:      gl.getUniformLocation(_prog,'u_turb'),
    orbs:      gl.getUniformLocation(_prog,'u_orbs'),
    pulse:     gl.getUniformLocation(_prog,'u_pulse'),
    pulse2:    gl.getUniformLocation(_prog,'u_pulse2'),
    intensity: gl.getUniformLocation(_prog,'u_intensity'),
    phase:     gl.getUniformLocation(_prog,'u_phase'),
    bassFlow:  gl.getUniformLocation(_prog,'u_bassFlow'),
    mouse:     gl.getUniformLocation(_prog,'u_mouse'),
};

function _resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', _resize); _resize();

let _mouseX=0.5, _mouseY=0.5, _tgtX=0.5, _tgtY=0.5;
window.addEventListener('mousemove', e => {
    _tgtX = e.clientX / window.innerWidth;
    _tgtY = 1.0 - (e.clientY / window.innerHeight);
});

// ── Palette helpers ───────────────────────────────────────────
function _lerpPalette() {
    for (let i=0;i<3;i++)
        for (let j=0;j<3;j++)
            _currentPalette[i][j] += (_targetPalette[i][j] - _currentPalette[i][j]) * 0.025;
}

function _hashPalette(str) {
    let h=0;
    for (let i=0;i<str.length;i++) h=str.charCodeAt(i)+((h<<5)-h);
    const hue=Math.abs(h%360)/360;
    const hx=(p,q,t)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;};
    const h2r=(h,s,l)=>{ const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q; return [hx(p,q,h+1/3),hx(p,q,h),hx(p,q,h-1/3)]; };
    return [h2r(hue,0.8,0.12), h2r((hue+0.1)%1,0.9,0.58), h2r((hue-0.1+1)%1,1.0,0.04)];
}

// ── Thumbnail colour extractor ────────────────────────────────
// YouTube thumbnails are CORS-accessible (unlike the iframe itself).
// We draw the thumbnail into a tiny canvas, average the pixels,
// and derive a graceful 3-tone palette from the dominant colour.
// This runs once when a song loads + re-samples every 30s.

let _thumbInterval  = null;
let _thumbVideoId   = null;

function _sampleThumbnailColour(videoId) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // maxresdefault → hqdefault fallback
    img.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    img.onload = () => {
        try {
            const tc  = document.createElement('canvas');
            tc.width  = 32; tc.height = 18;
            const ctx = tc.getContext('2d');
            ctx.drawImage(img, 0, 0, 32, 18);
            const px  = ctx.getImageData(0, 0, 32, 18).data;

            let r=0, g=0, b=0, n=0;
            for (let i=0; i<px.length; i+=16) { r+=px[i]; g+=px[i+1]; b+=px[i+2]; n++; }
            r /= n*255; g /= n*255; b /= n*255;

            // Boost saturation so the palette feels vivid, not muddy
            const mx   = Math.max(r,g,b) || 0.01;
            const sat  = 1.4;            // saturation boost
            const br   = r/mx, bg = g/mx, bb = b/mx;

            const vivid  = [Math.min(1,br*sat*mx*2.0), Math.min(1,bg*sat*mx*2.0), Math.min(1,bb*sat*mx*2.0)];
            const dark   = [r*0.12, g*0.12, b*0.12];
            const deep   = [r*0.05, g*0.05, b*0.05];

            _targetPalette = [dark, vivid, deep];
            GradientController.setBasePalette(vivid, dark);
        } catch(e) {
            // canvas taint on some browsers — harmless, keep current palette
        }
    };
    img.onerror = () => {}; // silently ignore network errors
}

function _startThumbSampling(videoId) {
    _stopThumbSampling();
    _thumbVideoId = videoId;
    _sampleThumbnailColour(videoId);
    // Re-sample every 30s — thumbnail doesn't change but
    // this keeps the palette fresh if user changes song
    _thumbInterval = setInterval(() => _sampleThumbnailColour(videoId), 30000);
}

function _stopThumbSampling() {
    if (_thumbInterval) { clearInterval(_thumbInterval); _thumbInterval = null; }
    _thumbVideoId = null;
}

// ── Render loop ───────────────────────────────────────────────
let _time    = 0;
let _lastRAF = null;

function _render(now) {
    const dt = _lastRAF ? Math.min((now - _lastRAF) / 1000, 0.05) : 0.016;
    _lastRAF  = now;
    _time    += dt;

    // Advance all audio-reactive decays at true 60fps
    GradientController.frame(dt);

    _mouseX += (_tgtX - _mouseX) * 0.06;
    _mouseY += (_tgtY - _mouseY) * 0.06;
    _lerpPalette();

    const gfx = GradientController.gfx;
    const c0  = gfx.bottomColor || _currentPalette[0];
    const c1  = gfx.topColor    || _currentPalette[1];
    const c2  = _currentPalette[2];

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

    async setSong(songName, artistName, youtubeUrl, authToken) {
        const API = 'https://onesong.onrender.com';

        // Extract video ID from URL for thumbnail sampling
        const vidMatch = youtubeUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([0-9A-Za-z_-]{11})/);
        const videoId  = vidMatch ? vidMatch[1] : null;

        // ── 1. Mood palette (fast, sets initial colours) ──────
        try {
            const r = await fetch(
                `${API}/mood?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`,
                { headers: { Authorization: `Bearer ${authToken}` } }
            );
            const { tags = [] } = await r.json();
            let palette = null;
            for (const tag of tags) { if (MOODS[tag]) { palette = MOODS[tag]; break; } }
            if (!palette) palette = _hashPalette(songName);
            _targetPalette = palette;
            GradientController.setBasePalette(palette[1], palette[0]);
        } catch(e) {
            const p = _hashPalette(songName);
            _targetPalette = p;
            GradientController.setBasePalette(p[1], p[0]);
        }

        // ── 2. Thumbnail colour sample (overrides mood palette) ─
        if (videoId) _startThumbSampling(videoId);

        // ── 3. Audio analysis — non-blocking, 90s timeout ─────
        try {
            const toastFn = window.showToast || (() => {});
            const hideFn  = window.hideToast  || (() => {});
            toastFn('🎵 Analysing audio…', '#a78bfa', true);

            const controller = new AbortController();
            const timeout    = setTimeout(() => controller.abort(), 90000);

            const r = await fetch(`${API}/analyze/audio`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json',
                           Authorization: `Bearer ${authToken}` },
                body:    JSON.stringify({ youtube_url: youtubeUrl }),
                signal:  controller.signal,
            });
            clearTimeout(timeout);
            hideFn();

            if (r.ok) {
                GradientController.loadAudioData(await r.json());
                toastFn('✓ Visuals synced to audio', '#4ade80');
                setTimeout(hideFn, 2500);
            } else {
                console.warn('[Ambient] audio analysis HTTP', r.status);
            }
        } catch(e) {
            if (window.hideToast) window.hideToast();
            if (e.name !== 'AbortError') {
                console.warn('[Ambient] audio analysis failed — spacebar sync available');
            }
        }
    },

    tickAudio(currentTime, isPlaying) {
        GradientController.updatePlayhead(currentTime, isPlaying);
    },

    syncBeat() {
        GradientController.triggerBeat();
    },

    reset() {
        _stopThumbSampling();
        _targetPalette = [
            [0.05, 0.05, 0.1 ],
            [0.2,  0.5,  0.9 ],
            [0.01, 0.01, 0.05],
        ];
        GradientController.reset();
    },
};