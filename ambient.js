/**
 * ambient.js — GPGPU Flow Field Visualizer  v3.2
 * ─────────────────────────────────────────────────────────────
 * Three.js r128 · 512×256 FBO ping-pong · 131 072 particles
 * Curl-noise physics · Persistence trail · ACES tonemap
 *
 * FIXES vs v3.1:
 *  [A] renderer.autoClear=false required explicit renderer.clear() before
 *      particleRT pass — now correctly called.
 *  [B] Silent-boot guarantee: field animates on uIdle=1 from frame 0,
 *      regardless of AudioContext/GradientController state.
 *  [C] All NDC passes use dedicated ortho camera (was already fixed in
 *      v3.1 but ortho was not passed to prime() scene renders correctly).
 *  [D] Float texture fallback now also checks LINEAR_FLOAT extension.
 *  [E] resize handler also resets particleCam aspect immediately.
 *  [F] init() is idempotent and returns true/false for caller feedback.
 */

const Ambient = (() => {

  const FBO_W       = 512;
  const FBO_H       = 256;
  const TRAIL_DECAY = 0.960;
  const IDLE_SPD    = 0.20;

  let renderer, clock, ortho;
  let posA, posB, velA, velB, trailA, trailB, particleRT;
  let simMat, velMat, particleMat, trailMat, finalMat;
  let simSc, velSc, particleSc, trailSc, finalSc;
  let particleCam;
  let palTop, palBot;
  let initialized = false;
  let lastMs = 0;
  let rafId = null;

  let _loud = 0, _cent = 0, _beat = 0;
  const _mels = new Float32Array(8);

  // ── NDC vertex shader ─────────────────────────────────────
  const NDC_V = /* glsl */`
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // ── Simplex + Curl ────────────────────────────────────────
  const NOISE = /* glsl */`
    vec3  _m3(vec3 x) { return x - floor(x*(1./289.))*289.; }
    vec4  _m4(vec4 x) { return x - floor(x*(1./289.))*289.; }
    vec4  _p4(vec4 x) { return _m4(((x*34.)+1.)*x); }
    vec4  _ti(vec4 r) { return 1.79284291 - 0.85373472*r; }

    float snoise(vec3 v){
      const vec2 C = vec2(1./6., 1./3.);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g  = step(x0.yzx, x0.xyz);
      vec3 l  = 1.0 - g;
      vec3 i1 = min(g, l.zxy);
      vec3 i2 = max(g, l.zxy);
      vec3 x1 = x0 - i1 + C.x;
      vec3 x2 = x0 - i2 + C.y;
      vec3 x3 = x0 - 0.5;
      i = _m3(i);
      vec4 p = _p4(_p4(_p4(
        i.z + vec4(0., i1.z, i2.z, 1.)) +
        i.y + vec4(0., i1.y, i2.y, 1.)) +
        i.x + vec4(0., i1.x, i2.x, 1.));
      vec3 ns  = vec3(0.142857) * vec3(0.,1.,2.) - 0.333333;
      vec4 j   = p - 49.*floor(p * 0.020408);
      vec4 x_  = floor(j * 0.142857);
      vec4 y_  = floor(j - 7.*x_);
      vec4 xx  = x_*0.142857 + ns.y;
      vec4 yy  = y_*0.142857 + ns.y;
      vec4 hh  = 1.0 - abs(xx) - abs(yy);
      vec4 b0  = vec4(xx.xy, yy.xy);
      vec4 b1  = vec4(xx.zw, yy.zw);
      vec4 s0  = floor(b0)*2.0 + 1.0;
      vec4 s1  = floor(b1)*2.0 + 1.0;
      vec4 sh  = -step(hh, vec4(0.));
      vec4 a0  = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1  = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0  = vec3(a0.xy, hh.x);
      vec3 p1  = vec3(a0.zw, hh.y);
      vec3 p2  = vec3(a1.xy, hh.z);
      vec3 p3  = vec3(a1.zw, hh.w);
      vec4 nm  = _ti(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0 *= nm.x; p1 *= nm.y; p2 *= nm.z; p3 *= nm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
      m *= m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    vec3 curlNoise(vec3 p){
      const float e = 0.0001;
      float nx1=snoise(p+vec3(e,0,0)), nx0=snoise(p-vec3(e,0,0));
      float ny1=snoise(p+vec3(0,e,0)), ny0=snoise(p-vec3(0,e,0));
      float nz1=snoise(p+vec3(0,0,e)), nz0=snoise(p-vec3(0,0,e));
      return vec3(
        (ny1-ny0) - (nz1-nz0),
        (nz1-nz0) - (nx1-nx0),
        (nx1-nx0) - (ny1-ny0)
      ) / (2.0 * e);
    }

    float rng(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  `;

  // Shared uniform block
  const U = {
    uPos:   {value: null},
    uVel:   {value: null},
    uTime:  {value: 0},
    uDt:    {value: 0.016},
    uLoud:  {value: 0},
    uCent:  {value: 0},
    uBeat:  {value: 0},
    uBass:  {value: 0},
    uMid:   {value: 0},
    uIdle:  {value: 1.0},
  };

  const SIM_F = /* glsl */`
    precision highp float;
    uniform sampler2D uPos, uVel;
    uniform float uTime, uDt, uLoud, uCent, uBeat, uBass, uMid, uIdle;
    varying vec2 vUv;
    ${NOISE}

    void main(){
      vec3 pos = texture2D(uPos, vUv).xyz;
      vec3 vel = texture2D(uVel, vUv).xyz;

      float idleSpd = uIdle * ${IDLE_SPD.toFixed(4)};
      float freq    = 0.72 + uCent * 2.6;
      float spd     = idleSpd + 0.20 + uLoud * 2.0 + uBass * 0.85;

      vec3 np  = pos * freq + vec3(uTime*0.10, uTime*0.07, uTime*0.083);
      vec3 cur = curlNoise(np) * spd;
      cur.y   += uMid * snoise(pos*1.6 + vec3(0.0, uTime*0.15, 0.0)) * 0.45;

      float d = length(pos);
      vel += normalize(pos + 1e-5) * uBeat * 2.8 * exp(-d * 2.0);
      vel += (cur - vel * 0.52) * uDt * 2.6;
      vel *= 0.983;

      if(d > 1.1) vel -= normalize(pos) * (d - 1.1) * 1.1 * uDt;

      pos += vel * uDt;

      float r1 = rng(vUv);
      float r2 = rng(vUv + vec2(3.7, 9.2));
      if(length(pos) > 1.65 || dot(vel, vel) < 1e-9){
        float th = r1 * 6.28318;
        float ph = acos(2.0*r2 - 1.0);
        float rr = 0.28 + r1 * 0.54;
        pos = vec3(sin(ph)*cos(th)*rr, sin(ph)*sin(th)*rr, cos(ph)*rr);
        vel = vec3(0.0);
      }

      gl_FragColor = vec4(pos, length(vel));
    }
  `;

  const VEL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uPos, uVel;
    uniform float uTime, uDt, uLoud, uCent, uBeat, uBass, uMid, uIdle;
    varying vec2 vUv;
    ${NOISE}

    void main(){
      vec3 pos = texture2D(uPos, vUv).xyz;
      vec3 vel = texture2D(uVel, vUv).xyz;

      float idleSpd = uIdle * ${IDLE_SPD.toFixed(4)};
      float freq    = 0.72 + uCent * 2.6;
      float spd     = idleSpd + 0.20 + uLoud * 2.0 + uBass * 0.85;

      vec3 np  = pos * freq + vec3(uTime*0.10, uTime*0.07, uTime*0.083);
      vec3 cur = curlNoise(np) * spd;
      cur.y   += uMid * snoise(pos*1.6 + vec3(0.0, uTime*0.15, 0.0)) * 0.45;

      float d = length(pos);
      vel += normalize(pos + 1e-5) * uBeat * 2.8 * exp(-d * 2.0);
      vel += (cur - vel * 0.52) * uDt * 2.6;
      vel *= 0.983;
      if(d > 1.1) vel -= normalize(pos) * (d - 1.1) * 1.1 * uDt;

      if(length(pos) > 1.65 || dot(vel, vel) < 1e-9) vel = vec3(0.0);

      gl_FragColor = vec4(vel, 1.0);
    }
  `;

  const PART_V = /* glsl */`
    uniform sampler2D uPos;
    uniform float uBass, uLoud, uBeat;
    uniform vec3  uTop, uBot;
    varying vec3  vCol;
    varying float vA;

    void main(){
      vec4  t   = texture2D(uPos, position.xy);
      vec3  pos = t.xyz;
      float vm  = t.w;

      vec4  mv  = modelViewMatrix * vec4(pos, 1.0);
      gl_Position  = projectionMatrix * mv;

      float sz     = 1.1 + uBass*2.5 + uBeat*1.8;
      gl_PointSize = sz * (260.0 / max(-mv.z, 0.1));

      float yt = clamp(pos.y * 0.5 + 0.5, 0.0, 1.0);
      vCol = mix(uBot, uTop, yt) + uTop * uBeat * 0.12;
      vA   = clamp(0.28 + vm*0.4 + uLoud*0.55, 0.04, 1.0);
    }
  `;

  const PART_F = /* glsl */`
    precision highp float;
    varying vec3  vCol;
    varying float vA;
    void main(){
      float r = length(gl_PointCoord - 0.5);
      if(r > 0.5) discard;
      float e = 1.0 - r * 2.0;
      gl_FragColor = vec4(vCol * (1.0 + e * 0.85), e * e * vA);
    }
  `;

  const TRAIL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uPart, uTrail;
    uniform float uDecay;
    varying vec2 vUv;
    void main(){
      gl_FragColor = clamp(
        texture2D(uTrail, vUv) * uDecay + texture2D(uPart, vUv),
        0.0, 1.0
      );
    }
  `;

  const FINAL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uTrail;
    uniform float uBright;
    varying vec2 vUv;

    vec3 aces(vec3 x){
      return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
    }

    void main(){
      vec2  off = (vUv - 0.5) * 0.0045;
      float r   = texture2D(uTrail, vUv + off).r;
      float g   = texture2D(uTrail, vUv      ).g;
      float b   = texture2D(uTrail, vUv - off).b;
      vec3  c   = aces(vec3(r, g, b) * uBright);

      vec2 uv2 = vUv - 0.5;
      c *= clamp(1.0 - dot(uv2, uv2) * 1.5, 0.0, 1.0);

      gl_FragColor = vec4(c, 1.0);
    }
  `;

  // ── Helpers ───────────────────────────────────────────────
  function mkFBO(w, h, type){
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format:    THREE.RGBAFormat,
      type,
      depthBuffer:   false,
      stencilBuffer: false,
    });
  }

  function mkNDCScene(mat){
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    return sc;
  }

  function prime(fboTarget, data, type){
    const tex = new THREE.DataTexture(data, FBO_W, FBO_H, THREE.RGBAFormat, type);
    tex.needsUpdate = true;
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: tex })
    ));
    renderer.setRenderTarget(fboTarget);
    renderer.clear();
    renderer.render(sc, ortho);
    renderer.setRenderTarget(null);
    // intentionally not disposing tex — let GC handle
  }

  // ── PUBLIC: init() ────────────────────────────────────────
  function init(){
    if(initialized) return true;

    const canvas = document.getElementById('ambient-canvas');
    if(!canvas){
      console.error('[Ambient] #ambient-canvas not found');
      return false;
    }

    // Enforce CSS — belt-and-braces
    Object.assign(canvas.style, {
      position:      'fixed',
      inset:         '0',
      width:         '100vw',
      height:        '100vh',
      zIndex:        '-1',
      display:       'block',
      pointerEvents: 'none',
    });

    // ── WebGL renderer ──
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias:       false,
        alpha:           false,
        powerPreference: 'high-performance',
      });
    } catch(e){
      console.error('[Ambient] WebGL init failed:', e);
      _cssFallback(canvas);
      return false;
    }

    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.autoClear = false;

    const gl = renderer.getContext();

    // Float texture support — check all variants
    const hasF   = !!gl.getExtension('OES_texture_float');
    const hasHF  = !!gl.getExtension('OES_texture_half_float');
    const hasLF  = !!gl.getExtension('OES_texture_float_linear');
    if(!hasF && !hasHF){
      console.warn('[Ambient] No float texture support — CSS fallback');
      _cssFallback(canvas);
      return false;
    }
    // Prefer full float when linear filtering is also available
    const sType = (hasF && hasLF) ? THREE.FloatType : THREE.HalfFloatType;

    clock = new THREE.Clock();
    ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── FBO allocation ──
    posA  = mkFBO(FBO_W, FBO_H, sType);  posB  = mkFBO(FBO_W, FBO_H, sType);
    velA  = mkFBO(FBO_W, FBO_H, sType);  velB  = mkFBO(FBO_W, FBO_H, sType);
    trailA     = mkFBO(innerWidth, innerHeight, THREE.HalfFloatType);
    trailB     = mkFBO(innerWidth, innerHeight, THREE.HalfFloatType);
    particleRT = mkFBO(innerWidth, innerHeight, THREE.HalfFloatType);

    // ── Prime position FBO ──
    const posData = new Float32Array(FBO_W * FBO_H * 4);
    for(let i = 0; i < FBO_W * FBO_H; i++){
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 0.25 + Math.random() * 0.55;
      posData[i*4]   = Math.sin(ph) * Math.cos(th) * r;
      posData[i*4+1] = Math.sin(ph) * Math.sin(th) * r;
      posData[i*4+2] = Math.cos(ph) * r;
      posData[i*4+3] = 0.001;
    }
    prime(posA, posData, sType);
    prime(posB, posData, sType);
    prime(velA, new Float32Array(FBO_W * FBO_H * 4), sType);
    prime(velB, new Float32Array(FBO_W * FBO_H * 4), sType);

    // ── Sim materials ──
    U.uPos.value = posA.texture;
    U.uVel.value = velA.texture;
    simMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: NDC_V, fragmentShader: SIM_F });
    velMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: NDC_V, fragmentShader: VEL_F });
    simSc  = mkNDCScene(simMat);
    velSc  = mkNDCScene(velMat);

    // ── Palette ──
    palTop = new THREE.Color(0.06, 0.14, 0.38);
    palBot = new THREE.Color(0.02, 0.02, 0.08);

    // ── Particle material + geometry ──
    particleMat = new THREE.ShaderMaterial({
      uniforms: {
        uPos:  { value: posA.texture },
        uBass: { value: 0 },
        uLoud: { value: 0 },
        uBeat: { value: 0 },
        uTop:  { value: new THREE.Vector3(palTop.r, palTop.g, palTop.b) },
        uBot:  { value: new THREE.Vector3(palBot.r, palBot.g, palBot.b) },
      },
      vertexShader:   PART_V,
      fragmentShader: PART_F,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
      depthTest:      false,
    });

    const uvBuf = new Float32Array(FBO_W * FBO_H * 3);
    for(let y = 0, k = 0; y < FBO_H; y++) for(let x = 0; x < FBO_W; x++){
      uvBuf[k++] = (x + 0.5) / FBO_W;
      uvBuf[k++] = (y + 0.5) / FBO_H;
      uvBuf[k++] = 0;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(uvBuf, 3));

    particleSc  = new THREE.Scene();
    particleSc.add(new THREE.Points(pGeo, particleMat));
    particleCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
    particleCam.position.z = 2.2;

    // ── Trail material ──
    trailMat = new THREE.ShaderMaterial({
      uniforms: { uPart: {value: null}, uTrail: {value: null}, uDecay: {value: TRAIL_DECAY} },
      vertexShader:   NDC_V,
      fragmentShader: TRAIL_F,
    });
    trailSc = mkNDCScene(trailMat);

    // ── Final composite ──
    finalMat = new THREE.ShaderMaterial({
      uniforms: { uTrail: {value: null}, uBright: {value: 1.0} },
      vertexShader:   NDC_V,
      fragmentShader: FINAL_F,
    });
    finalSc = mkNDCScene(finalMat);

    // ── Resize handler ──
    window.addEventListener('resize', () => {
      const w = innerWidth, h = innerHeight;
      renderer.setSize(w, h);
      trailA.setSize(w, h);
      trailB.setSize(w, h);
      particleRT.setSize(w, h);
      particleCam.aspect = w / h;
      particleCam.updateProjectionMatrix();
    });

    initialized = true;

    // ── START RENDER LOOP immediately — no waiting for audio ──
    _startLoop();
    return true;
  }

  function _cssFallback(canvas){
    canvas.style.background = 'radial-gradient(ellipse at 50% 55%, #09091a 0%, #020208 100%)';
  }

  function _startLoop(){
    if(rafId !== null) return; // already running
    lastMs = performance.now();

    ;(function loop(ms){
      rafId = requestAnimationFrame(loop);

      const dt = Math.min((ms - lastMs) / 1000, 0.05);
      lastMs = ms;
      const t  = clock.getElapsedTime();

      // ── Feature sampling ──
      let loud = _loud, cent = _cent, beat = _beat, bass = _mels[0], mid = _mels[3];
      let isIdle = 1.0; // default: field runs on internal clock

      if(window.GradientController){
        try {
          GradientController.frame(dt);
          const g = GradientController.gfx;
          // Only switch off idle mode if GC has meaningful signal
          const gcLoud = Math.max(0, g.intensity - 1.0);
          if(gcLoud > 0.01 || g.pulse > 0.01){
            loud   = gcLoud;
            beat   = g.pulse;
            cent   = g.centroid;
            bass   = (g.melbands && g.melbands[0]) ? g.melbands[0] : _mels[0];
            mid    = (g.melbands && g.melbands[3]) ? g.melbands[3] : _mels[3];
            isIdle = 0.0;
          }

          const a = Math.min(dt * 2.0, 1.0);
          palTop.lerp(new THREE.Color(g.topColor[0],    g.topColor[1],    g.topColor[2]),    a);
          palBot.lerp(new THREE.Color(g.bottomColor[0], g.bottomColor[1], g.bottomColor[2]), a);
        } catch(e) {
          // GC threw — keep idle mode running
        }
      }

      // Write uniforms
      U.uTime.value = t;
      U.uDt.value   = dt;
      U.uLoud.value = loud;
      U.uCent.value = cent;
      U.uBeat.value = beat;
      U.uBass.value = bass;
      U.uMid.value  = mid;
      U.uIdle.value = isIdle;

      // PASS 1a — velocity update
      U.uPos.value = posA.texture;
      U.uVel.value = velA.texture;
      renderer.setRenderTarget(velB);
      renderer.clear();
      renderer.render(velSc, ortho);
      [velA, velB] = [velB, velA];

      // PASS 1b — position update
      U.uPos.value = posA.texture;
      U.uVel.value = velA.texture;
      renderer.setRenderTarget(posB);
      renderer.clear();
      renderer.render(simSc, ortho);
      [posA, posB] = [posB, posA];

      // PASS 2 — render particles to intermediate RT
      // FIX [A]: must clear particleRT before rendering or trails from
      // previous frame accumulate incorrectly (black smear artefact)
      particleMat.uniforms.uPos.value  = posA.texture;
      particleMat.uniforms.uBass.value = bass;
      particleMat.uniforms.uLoud.value = loud;
      particleMat.uniforms.uBeat.value = beat;
      particleMat.uniforms.uTop.value.set(palTop.r, palTop.g, palTop.b);
      particleMat.uniforms.uBot.value.set(palBot.r, palBot.g, palBot.b);
      renderer.setRenderTarget(particleRT);
      renderer.clear(); // FIX [A]: explicit clear — autoClear is false
      renderer.render(particleSc, particleCam);

      // PASS 3 — trail feedback
      trailMat.uniforms.uPart.value  = particleRT.texture;
      trailMat.uniforms.uTrail.value = trailB.texture;
      trailMat.uniforms.uDecay.value = TRAIL_DECAY - loud * 0.022;
      renderer.setRenderTarget(trailA);
      renderer.clear();
      renderer.render(trailSc, ortho);
      [trailA, trailB] = [trailB, trailA];

      // PASS 4 — final composite to screen
      finalMat.uniforms.uTrail.value  = trailA.texture;
      finalMat.uniforms.uBright.value = 0.90 + loud * 0.42;
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(finalSc, ortho);

    })(performance.now());
  }

  // ── PUBLIC: setSong ───────────────────────────────────────
  function setSong(name, artist, token){
    reset();
    if(!token) return;

    const PALETTES = {
      sad:        { top:[.12,.22,.55], bot:[0,0,.04]    },
      happy:      { top:[1,.76,.14],   bot:[.35,.02,.08] },
      electronic: { top:[.82,.12,.98], bot:[0,0,.10]    },
      chill:      { top:[.32,.78,.55], bot:[.04,.10,.04] },
      rock:       { top:[.90,.26,.08], bot:[.10,0,0]    },
      pop:        { top:[.98,.44,.68], bot:[.18,0,.18]  },
      jazz:       { top:[.80,.58,.16], bot:[.10,.04,0]  },
      classical:  { top:[.90,.88,.80], bot:[.08,.08,.13] },
      metal:      { top:[.60,.10,.10], bot:[.05,0,0]    },
      ambient:    { top:[.10,.40,.70], bot:[.02,.04,.08] },
    };

    function hashPalette(s){
      const h = [...s].reduce((a,c) => ((a<<5)-a)+c.charCodeAt(0), 0);
      const hue = Math.abs(h % 360) / 360;
      const hsl = (h,s,l) => {
        const q = l<.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
        const f = t => { t=((t%1)+1)%1; return t<1/6?p+(q-p)*6*t:t<.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p; };
        return [f(h+1/3), f(h), f(h-1/3)];
      };
      return { top: hsl(hue,.9,.60), bot: hsl((hue+.5)%1,.8,.07) };
    }

    fetch(`https://onesong.onrender.com/mood?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`,
      { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.ok ? r.json() : {tags: []})
    .then(({tags=[]}) => {
      let pal = null;
      for(const tag of tags){ if(PALETTES[tag]){ pal = PALETTES[tag]; break; } }
      if(!pal) pal = hashPalette(name);
      if(window.GradientController) GradientController.setBasePalette(pal.top, pal.bot);
    })
    .catch(() => {});
  }

  function setAudioFeatures({ loudness=0, centroid=0, melbands=null, beat=0 } = {}){
    _loud = loudness;
    _cent = centroid;
    _beat = beat;
    if(melbands) for(let i = 0; i < 8; i++) _mels[i] = melbands[i] ?? 0;
  }

  function startBeat(){ if(window.GradientController) GradientController.updatePlayhead(0, true); }
  function stopBeat() { if(window.GradientController) GradientController.updatePlayhead(0, false); }
  function syncBeat(){
    if(window.GradientController) GradientController.triggerBeat();
    _mels[0] = Math.min(1, _mels[0] + 0.65);
    setTimeout(() => { _mels[0] *= 0.18; }, 110);
  }

  function reset(){
    _loud = 0; _cent = 0; _beat = 0; _mels.fill(0);
    if(window.GradientController) GradientController.reset();
    if(renderer && trailA && trailB){
      renderer.setRenderTarget(trailA); renderer.clear();
      renderer.setRenderTarget(trailB); renderer.clear();
      renderer.setRenderTarget(null);
    }
  }

  return { init, setSong, setAudioFeatures, startBeat, stopBeat, syncBeat, reset };
})();