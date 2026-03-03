/**
 * ambient.js — GPGPU Flow Field Visualizer  v5.0
 * ─────────────────────────────────────────────────────────────
 * Improvements over v4.0:
 *
 * [V1] DUAL-LAYER CURL NOISE — two noise octaves at different frequencies
 *      break up repeating vortex patterns; second layer animates at offset phase.
 *
 * [V2] PARTICLE LIFETIME FADE — pos.w lifetime now drives per-particle
 *      fade-in/out in fragment shader; particles born and die visibly.
 *      Boundary wrap uses fade-out/respawn instead of hard toroidal pop.
 *
 * [V3] CAMERA ORBIT — slow continuous figure-8 Lissajous path replaces
 *      static camera. Bass shake replaced with smooth LFO-based oscillation.
 *
 * [V4] PER-BAND SPATIAL COLOR — bass drives center warmth, treble drives
 *      edge coolness; center/edge hue separation gives two-tone depth.
 *
 * [V5] SPECTRAL FLUX — derivative of spectrum energy drives color shift
 *      intensity. Verse→chorus transitions and instrument entries trigger
 *      visible color responses that raw RMS misses.
 *
 * [V6] DENSITY BIAS — particles respawn toward high-curl regions rather
 *      than uniformly; flow concentrates where visually interesting.
 *
 * [V7] IDLE HUE DRIFT — slow hue rotation when no audio, prevents dead look.
 *
 * [V8] HALF-RES BLOOM — bloom renders at 0.5× resolution, saves GPU budget.
 *
 * [V9] ADAPTIVE COMPUTE THROTTLE — GPGPU skips every other frame when
 *      audio energy is very low; freed budget spent on visual quality.
 *
 * [V10] MOBILE SHAKE FIX — camera shake uses sin/cos LFO at 2–4 Hz,
 *       scaled by bass, instead of Math.random() jitter.
 *
 * [C1] COLOR FIX — lightness clamped to 0.62 max, base saturation raised,
 *      bloom threshold raised to 0.35, bloom radius tightened to 0.4.
 */

const Ambient = (() => {

  // ── Constants ─────────────────────────────────────────────
  const PARTICLE_TEXTURE_SIZE = 256;
  const NUM_PARTICLES = PARTICLE_TEXTURE_SIZE * PARTICLE_TEXTURE_SIZE;

  // ── Module state ──────────────────────────────────────────
  let renderer, scene, camera, clock;
  let gpuCompute;
  let posVar, velVar;
  let particlesMesh;
  let composer, bloomPass;
  let initialized = false;
  let rafId = null;

  // [V3] Camera orbit state
  let _orbitT      = 0;       // orbit phase time accumulator
  let _shakeLFO_x  = 0;       // [V10] smooth LFO shake X
  let _shakeLFO_y  = 0;       // [V10] smooth LFO shake Y
  let _shakeAmt    = 0;
  let _bloomStr    = 0;

  // [V9] Adaptive throttle state
  let _skipFrame   = false;   // toggles each low-energy frame

  // ── Palette ───────────────────────────────────────────────
  let _palHue      = 220;     // primary hue, driven by centroid
  let _palShift    = 0;
  let _idleHue     = 0;       // [V7] idle drift accumulator

  // [V5] Spectral flux
  let _prevFreqSum = 0;
  let _flux        = 0;

  // ── Audio uniforms ────────────────────────────────────────
  const _audio = {
    loudness:  0,
    centroid:  0,
    bass:      0,
    treble:    0,
    beat:      0,
    // [V4] per-band spatial
    mids:      0,
    flux:      0,
  };

  // ── GLSL: 3D Simplex Noise ────────────────────────────────
  const GLSL_NOISE = /* glsl */`
    vec3 mod289v3(vec3 x){ return x - floor(x*(1./289.))*289.; }
    vec4 mod289v4(vec4 x){ return x - floor(x*(1./289.))*289.; }
    vec4 permute(vec4 x){ return mod289v4(((x*34.)+1.)*x); }
    vec4 taylorInvSqrt(vec4 r){ return 1.79284291 - 0.85373472*r; }

    float snoise(vec3 v){
      const vec2 C = vec2(1./6., 1./3.);
      const vec4 D = vec4(0., 0.5, 1., 2.);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g  = step(x0.yzx, x0.xyz);
      vec3 l  = 1.0 - g;
      vec3 i1 = min(g, l.zxy);
      vec3 i2 = max(g, l.zxy);
      vec3 x1 = x0 - i1 + C.x;
      vec3 x2 = x0 - i2 + C.y;
      vec3 x3 = x0 - D.yyy;
      i = mod289v3(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0., i1.z, i2.z, 1.)) +
        i.y + vec4(0., i1.y, i2.y, 1.)) +
        i.x + vec4(0., i1.x, i2.x, 1.));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j  = p - 49.*floor(p*ns.z*ns.z);
      vec4 x_ = floor(j*ns.z);
      vec4 y_ = floor(j - 7.*x_);
      vec4 xx = x_*ns.x + ns.yyyy;
      vec4 yy = y_*ns.x + ns.yyyy;
      vec4 hh = 1.0 - abs(xx) - abs(yy);
      vec4 b0 = vec4(xx.xy, yy.xy);
      vec4 b1 = vec4(xx.zw, yy.zw);
      vec4 s0 = floor(b0)*2.+1.;
      vec4 s1 = floor(b1)*2.+1.;
      vec4 sh = -step(hh, vec4(0.));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, hh.x);
      vec3 p1 = vec3(a0.zw, hh.y);
      vec3 p2 = vec3(a1.xy, hh.z);
      vec3 p3 = vec3(a1.zw, hh.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
      m = m*m;
      return 42. * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    // Curl noise — divergence-free vector field
    vec3 curlNoise(vec3 p, float scale, float influence){
      float e = 0.0001;
      vec3 sp = p * scale;
      float nx1=snoise(sp+vec3(e,0,0)), nx0=snoise(sp-vec3(e,0,0));
      float ny1=snoise(sp+vec3(0,e,0)), ny0=snoise(sp-vec3(0,e,0));
      float nz1=snoise(sp+vec3(0,0,e)), nz0=snoise(sp-vec3(0,0,e));
      return vec3(
        (ny1-ny0)-(nz1-nz0),
        (nz1-nz0)-(nx1-nx0),
        (nx1-nx0)-(ny1-ny0)
      ) * influence / (2.0*e);
    }
  `;

  // ── GLSL: Velocity shader ─────────────────────────────────
  // [V1] Two curl noise layers at different scales/phases
  // [V6] Density bias: curl magnitude used to bias respawn (passed via vel.w)
  const VELOCITY_SHADER = /* glsl */`
    ${GLSL_NOISE}

    uniform float u_time;
    uniform float u_dt;
    uniform float u_audioIntensity;
    uniform float u_beat;
    uniform float u_treble;
    uniform float u_bass;
    uniform float u_mids;
    uniform float u_flux;

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      float intensity = 0.18 + u_audioIntensity * 1.2 + u_bass * 0.5;
      float scale1    = 0.55 + u_audioIntensity * 0.9;

      // [V1] PRIMARY curl layer — same as before but slightly tamed
      vec3 p3  = vec3(pos.xy, pos.z + u_time * 0.08);
      vec3 curl1 = curlNoise(p3, scale1, intensity);

      // [V1] SECONDARY curl layer — higher frequency, offset phase, lower weight
      // Uses a different time offset and scale to break up repeating patterns
      float scale2 = scale1 * 2.3;
      vec3 p3b = vec3(pos.xy * 1.1 + vec2(17.3, 31.7), pos.z - u_time * 0.05 + 5.4);
      vec3 curl2 = curlNoise(p3b, scale2, intensity * 0.38);

      // Blend layers — mids energy shifts weight toward secondary layer
      float blend = 0.25 + u_mids * 0.35;
      vec3 curl = mix(curl1, curl1 + curl2, blend);

      // High-frequency jitter (treble)
      float jitter = u_treble * 0.30;
      curl.xy += vec2(
        snoise(p3 * 4.2 + vec3(u_time * 0.3, 0., 0.)),
        snoise(p3 * 4.2 + vec3(0., u_time * 0.3, 0.))
      ) * jitter;

      // Steer velocity toward curl field
      vec3 steering = (curl - vel.xyz) * u_dt * 3.5;
      vel.xyz += steering;

      // Beat impulse — radial outward burst
      float dist = length(pos.xy);
      vel.xy += normalize(pos.xy + 0.0001) * u_beat * 2.0 * exp(-dist * 1.8) * u_dt * 60.0;

      // Damping
      vel.xyz *= 0.982;

      // Soft boundary — smooth falloff (no hard spring wall)
      float r = length(pos.xyz);
      float boundaryFade = smoothstep(1.3, 1.7, r);
      vel.xyz -= normalize(pos.xyz) * boundaryFade * 0.6 * u_dt * 60.0;

      // [V6] Store curl magnitude in w — used by position shader for density bias
      gl_FragColor = vec4(vel.xyz, length(curl1));
    }
  `;

  // ── GLSL: Position shader ─────────────────────────────────
  // [V2] Lifetime-based fade replaces hard toroidal wrap
  // [V6] Density-biased respawn toward high-curl regions
  const POSITION_SHADER = /* glsl */`
    uniform float u_dt;
    uniform float u_time;
    uniform float u_bass;

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      // Integrate position
      pos.xyz += vel.xyz * u_dt;

      // [V2] Soft fade-out near boundary instead of hard wrap
      // pos.w encodes: x = lifetime (0-1 normalized), wraps continuously
      float age      = pos.w;
      float lifetime = 8.0 + fract(sin(dot(uv, vec2(127.1, 311.7))) * 43758.5) * 12.0;
      age += u_dt / lifetime;

      // Out-of-bounds or old age → mark for respawn
      float r     = length(pos.xyz);
      bool oob    = r > 1.75;
      bool old    = age > 1.0;
      bool dead   = dot(vel.xyz, vel.xyz) < 1e-10;

      if(oob || old || dead){
        // [V6] Density-bias: use velocity curl magnitude (vel.w) to skew respawn
        // High curl magnitude → respawn closer to center where field is rich
        float curlMag = vel.w;
        float bias    = mix(0.8, 0.3, clamp(curlMag * 0.4, 0.0, 1.0));

        float rng1 = fract(sin(dot(uv + u_time * 0.001, vec2(127.1, 311.7))) * 43758.5453);
        float rng2 = fract(sin(dot(uv + u_time * 0.001, vec2(269.5, 183.3))) * 43758.5453);
        float rng3 = fract(sin(dot(uv + u_time * 0.001, vec2(419.2, 371.9))) * 43758.5453);
        float th   = rng1 * 6.28318;
        float ph   = acos(2.0 * rng2 - 1.0);
        float rr   = bias * (0.15 + rng3 * 0.55);

        // Bass energy → respawn burst slightly further out
        rr = mix(rr, rr * 1.3, u_bass * 0.4);

        pos.xyz  = vec3(sin(ph)*cos(th)*rr, sin(ph)*sin(th)*rr, cos(ph)*rr * 0.4);
        age = 0.0;
      }

      pos.w = age;
      gl_FragColor = pos;
    }
  `;

  // ── GLSL: Particle vertex shader ──────────────────────────
  // [V4] Per-band spatial color: bass→center warmth, treble→edge cool
  // [C1] Lightness clamped to 0.62, base saturation raised
  const PARTICLE_VERT = /* glsl */`
    uniform sampler2D tPosition;
    uniform sampler2D tVelocity;
    uniform float     u_audioIntensity;
    uniform float     u_bass;
    uniform float     u_treble;
    uniform float     u_mids;
    uniform float     u_beat;
    uniform float     u_hue;
    uniform float     u_hueSecondary;   // [V4] contrasting hue for edges
    uniform float     u_saturation;
    uniform float     u_flux;           // [V5] spectral flux → color shift
    uniform float     u_time;

    varying vec3  vColor;
    varying float vAlpha;

    vec3 hsl2rgb(float h, float s, float l){
      h = mod(h, 360.0) / 360.0;
      float r, g, b;
      float q = l < 0.5 ? l*(1.+s) : l+s-l*s;
      float p = 2.*l - q;
      float t;
      t = h + 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      r = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      t = h;         if(t<0.)t+=1.; if(t>1.)t-=1.;
      g = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      t = h - 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      b = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      return vec3(r, g, b);
    }

    void main(){
      vec2 gpuUV = position.xy;
      vec4 pos   = texture2D(tPosition, gpuUV);
      vec4 vel   = texture2D(tVelocity, gpuUV);

      vec4 mvPos  = modelViewMatrix * vec4(pos.xyz, 1.0);
      gl_Position = projectionMatrix * mvPos;

      float spd = length(vel.xyz);
      float sz  = 1.1 + spd * 2.4 + u_bass * 2.5 + u_beat * 2.0;
      gl_PointSize = sz * (300.0 / max(-mvPos.z, 0.5));

      // [V2] Lifetime fade — age in pos.w [0,1]
      float age   = pos.w;
      float fadeIn  = smoothstep(0.0, 0.08, age);
      float fadeOut = 1.0 - smoothstep(0.82, 1.0, age);
      float lifeFade = fadeIn * fadeOut;

      // [V4] Radial distance from origin → blend center hue vs edge hue
      float radial = clamp(length(pos.xy) / 1.4, 0.0, 1.0);

      // Bass hue = warm (shifted toward red/orange)
      float hueCenter = u_hue + u_flux * 25.0;
      // Treble hue = cool (complementary offset)
      float hueEdge   = u_hueSecondary + pos.z * 20.0;

      // [V4] Blend hue by radial position + per-band energy
      float bandBlend = clamp(radial + u_treble * 0.4 - u_bass * 0.3, 0.0, 1.0);
      float hue = mix(hueCenter, hueEdge, bandBlend);
      hue += spd * 30.0;  // speed tints within the band

      // [C1] Saturation: higher base, smaller loudness range
      float sat   = 0.75 + u_saturation * 0.20;
      // [C1] Lightness: clamped to 0.62 max to preserve color
      float lght  = 0.28 + spd * 0.30 + u_audioIntensity * 0.12 + u_mids * 0.08;
      lght = clamp(lght, 0.10, 0.62);

      vColor = hsl2rgb(hue, sat, lght);

      // Alpha driven by speed, loudness, and lifetime fade
      float rawAlpha = clamp(0.12 + spd * 0.55 + u_audioIntensity * 0.35, 0.03, 1.0);
      vAlpha = rawAlpha * lifeFade;
    }
  `;

  // ── GLSL: Particle fragment shader ────────────────────────
  const PARTICLE_FRAG = /* glsl */`
    varying vec3  vColor;
    varying float vAlpha;

    void main(){
      float d    = length(gl_PointCoord - vec2(0.5));
      if(d > 0.5) discard;
      float edge = 1.0 - d * 2.0;
      float glow = pow(edge, 1.6);
      gl_FragColor = vec4(vColor * (1.0 + glow * 0.5), glow * glow * vAlpha);
    }
  `;

  // ── Helper: sphere distribution ───────────────────────────
  function _sphereData(n) {
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 0.2 + Math.random() * 0.5;
      data[i*4]   = Math.sin(ph) * Math.cos(th) * r;
      data[i*4+1] = Math.sin(ph) * Math.sin(th) * r;
      data[i*4+2] = Math.cos(ph) * r * 0.2;
      data[i*4+3] = Math.random();   // random initial age [0,1]
    }
    return data;
  }

  // ── Public API: init ──────────────────────────────────────
  function init() {
    if (initialized) return true;

    const canvas = document.getElementById('ambient-canvas');
    if (!canvas) { console.error('[Ambient] #ambient-canvas not found'); return false; }

    Object.assign(canvas.style, {
      position: 'fixed', inset: '0',
      width: '100vw', height: '100vh',
      zIndex: '-1', display: 'block', pointerEvents: 'none',
    });

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias:        false,
        alpha:            true,
        powerPreference:  'high-performance',
        preserveDrawingBuffer: false,
      });
    } catch (e) {
      console.error('[Ambient] WebGL init failed:', e);
      _cssFallback(canvas);
      return false;
    }

    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x000000, 0);

    const gl = renderer.getContext();
    const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined')
      && (gl instanceof WebGL2RenderingContext);
    const hasHF = isWebGL2 || !!gl.getExtension('OES_texture_half_float');
    const hasF  = isWebGL2 || !!gl.getExtension('OES_texture_float');

    if (!hasHF && !hasF) {
      console.warn('[Ambient] No float texture support — CSS fallback');
      _cssFallback(canvas);
      return false;
    }

    scene  = new THREE.Scene();
    clock  = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
    camera.position.z = 2.8;

    if (typeof THREE.GPUComputationRenderer === 'undefined') {
      console.error('[Ambient] GPUComputationRenderer not loaded');
      _cssFallback(canvas);
      return false;
    }

    const SIZE = PARTICLE_TEXTURE_SIZE;
    gpuCompute = new THREE.GPUComputationRenderer(SIZE, SIZE, renderer);
    gpuCompute.setDataType(THREE.HalfFloatType);

    const initPos = gpuCompute.createTexture();
    const initVel = gpuCompute.createTexture();
    initPos.image.data.set(_sphereData(SIZE * SIZE));

    posVar = gpuCompute.addVariable('tPosition', POSITION_SHADER, initPos);
    velVar = gpuCompute.addVariable('tVelocity', VELOCITY_SHADER, initVel);

    gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
    gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

    Object.assign(posVar.material.uniforms, {
      u_dt:   { value: 0.016 },
      u_time: { value: 0 },
      u_bass: { value: 0 },
    });

    Object.assign(velVar.material.uniforms, {
      u_dt:             { value: 0.016 },
      u_time:           { value: 0 },
      u_audioIntensity: { value: 0 },
      u_beat:           { value: 0 },
      u_treble:         { value: 0 },
      u_bass:           { value: 0 },
      u_mids:           { value: 0 },
      u_flux:           { value: 0 },
    });

    const err = gpuCompute.init();
    if (err !== null) {
      console.error('[Ambient] GPUComputationRenderer init error:', err);
      _cssFallback(canvas);
      return false;
    }

    // Particle geometry — UV coords into GPGPU texture
    const uvs = new Float32Array(NUM_PARTICLES * 3);
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const idx = (j * SIZE + i) * 3;
        uvs[idx]   = (i + 0.5) / SIZE;
        uvs[idx+1] = (j + 0.5) / SIZE;
        uvs[idx+2] = 0;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(uvs, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tPosition:        { value: null },
        tVelocity:        { value: null },
        u_audioIntensity: { value: 0 },
        u_bass:           { value: 0 },
        u_treble:         { value: 0 },
        u_mids:           { value: 0 },
        u_beat:           { value: 0 },
        u_hue:            { value: 220 },
        u_hueSecondary:   { value: 40 },    // [V4] complementary hue
        u_saturation:     { value: 0.5 },
        u_flux:           { value: 0 },
        u_time:           { value: 0 },
      },
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
      depthTest:      false,
    });

    particlesMesh = new THREE.Points(geo, mat);
    scene.add(particlesMesh);

    _setupComposer();

    window.addEventListener('resize', _onResize);

    initialized = true;
    console.info(`[Ambient] Init OK v5.0 ✓ — ${NUM_PARTICLES.toLocaleString()} particles`);
    _startLoop();
    return true;
  }

  // [V8] Half-res bloom — renders at 0.5× to save GPU budget
  function _setupComposer() {
    if (typeof THREE.EffectComposer === 'undefined' ||
        typeof THREE.UnrealBloomPass === 'undefined') {
      console.warn('[Ambient] EffectComposer/UnrealBloomPass not loaded');
      composer = null;
      return;
    }

    composer = new THREE.EffectComposer(renderer);

    const renderPass = new THREE.RenderPass(scene, camera);
    composer.addPass(renderPass);

    // [V8] Half-resolution bloom — imperceptible quality loss, meaningful GPU saving
    const bloomRes = new THREE.Vector2(
      Math.floor(innerWidth  * 0.5),
      Math.floor(innerHeight * 0.5),
    );

    // [C1] Threshold raised to 0.20, radius tightened to 0.3
    bloomPass = new THREE.UnrealBloomPass(bloomRes, 0.6, 0.3, 0.20);
    composer.addPass(bloomPass);
  }

  function _onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    if (bloomPass) {
      // [V8] Keep bloom at half res on resize too
      bloomPass.resolution.set(Math.floor(w * 0.5), Math.floor(h * 0.5));
    }
  }

  function _cssFallback(canvas) {
    let hue = 220;
    const shimmer = setInterval(() => {
      hue = (hue + 0.12) % 360;
      const h2 = (hue + 50) % 360;
      canvas.style.background =
        `radial-gradient(ellipse at 50% 55%, hsl(${hue},55%,8%) 0%, hsl(${h2},35%,2%) 65%, #000 100%)`;
    }, 60);
    canvas._shimmerTimer = shimmer;
    canvas.style.position = 'fixed';
    canvas.style.inset    = '0';
    canvas.style.zIndex   = '-1';
  }

  // ── Render loop ───────────────────────────────────────────
  function _startLoop() {
    if (rafId !== null) return;

    ;(function loop() {
      rafId = requestAnimationFrame(loop);

      const dt  = Math.min(clock.getDelta(), 0.05);
      const t   = clock.getElapsedTime();

      const targetLoud   = _audio.loudness;
      const targetBass   = _audio.bass;
      const targetTreble = _audio.treble;
      const targetMids   = _audio.mids;
      const targetBeat   = _audio.beat;
      const targetFlux   = _audio.flux;

      // [V7] Idle hue drift — slow rotation when no audio
      const isActive = targetLoud > 0.05;
      if (!isActive) {
        _idleHue = (_idleHue + dt * 3.0) % 360;   // ~4°/s idle drift
      }

      // Smooth bloom + shake toward targets
      // [C1] Bass bloom multiplier halved
      _bloomStr += (0.5 + targetBass * 1.8 - _bloomStr) * dt * 4;
      _shakeAmt += (targetBass * 0.100       - _shakeAmt) * dt * 8;

      // Primary hue follows spectral centroid; flux adds momentary color kick
      const hueTarget = isActive
        ? _audio.centroid * 360 + _palShift + targetFlux * 30
        : 220 + _idleHue;
      _palHue += (hueTarget - _palHue) * dt * (isActive ? 1.2 : 0.3);

      // [V4] Secondary (edge) hue is complementary offset — shifts opposite direction
      const secondaryHue = _palHue + 150 + targetBass * 40;

      // [V9] Adaptive compute throttle — skip every other frame at very low energy
      const energy      = targetLoud + targetBass * 0.2;
      const doCompute   = energy > 0.04 || !_skipFrame;
      _skipFrame        = !_skipFrame;

      if (doCompute) {
        velVar.material.uniforms.u_dt.value             = dt;
        velVar.material.uniforms.u_time.value           = t;
        velVar.material.uniforms.u_audioIntensity.value = targetLoud;
        velVar.material.uniforms.u_beat.value           = targetBeat;
        velVar.material.uniforms.u_treble.value         = targetTreble;
        velVar.material.uniforms.u_bass.value           = targetBass;
        velVar.material.uniforms.u_mids.value           = targetMids;
        velVar.material.uniforms.u_flux.value           = targetFlux;

        posVar.material.uniforms.u_dt.value   = dt;
        posVar.material.uniforms.u_time.value = t;
        posVar.material.uniforms.u_bass.value = targetBass;

        gpuCompute.compute();
      }

      // Update particle material
      const mat = particlesMesh.material;
      mat.uniforms.tPosition.value        = gpuCompute.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.tVelocity.value        = gpuCompute.getCurrentRenderTarget(velVar).texture;
      mat.uniforms.u_audioIntensity.value = targetLoud;
      mat.uniforms.u_bass.value           = targetBass;
      mat.uniforms.u_treble.value         = targetTreble;
      mat.uniforms.u_mids.value           = targetMids;
      mat.uniforms.u_beat.value           = targetBeat;
      mat.uniforms.u_hue.value            = _palHue;
      mat.uniforms.u_hueSecondary.value   = secondaryHue;
      mat.uniforms.u_saturation.value     = 0.5 + targetLoud * 0.45;
      mat.uniforms.u_flux.value           = targetFlux;
      mat.uniforms.u_time.value           = t;

      // [V3] Continuous camera orbit — Lissajous figure-8 path
      _orbitT += dt * (0.06 + targetLoud * 0.05);   // speed up slightly with loudness
      const orbitR = 0.18 + targetBass * 0.15;       // orbit radius grows with bass
      const orbitX = Math.sin(_orbitT * 1.0) * orbitR;
      const orbitY = Math.sin(_orbitT * 2.0) * orbitR * 0.55;  // figure-8 ratio

      // [V10] Smooth LFO shake — sin/cos at ~3 Hz scaled by bass, NOT random
      const lfoFreq = 3.0 + targetBass * 3.0;
      _shakeLFO_x = Math.sin(t * lfoFreq * 3.0) * _shakeAmt;
      _shakeLFO_y = Math.cos(t * lfoFreq * 1.4) * _shakeAmt;

      camera.position.x = orbitX + _shakeLFO_x;
      camera.position.y = orbitY + _shakeLFO_y;
      // Camera always looks toward origin so orbit feels intentional
      camera.lookAt(0, 0, 0);

      // [C1] Bloom strength — bass drives up but clamped
      if (bloomPass) {
        bloomPass.strength = Math.max(0.25, Math.min(_bloomStr, 1.6));
      }

      // Render
      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }

      // Decay beat
      _audio.beat *= 0.78;
    })();
  }

  // ── Public: audio data feed ───────────────────────────────
  function setAudioFeatures({ loudness = 0, centroid = 0, melbands = null, beat = 0, freqData = null } = {}) {
    _audio.loudness = loudness;
    _audio.centroid = centroid;
    _audio.beat     = Math.max(_audio.beat, beat);

    if (melbands && melbands.length >= 8) {
      _audio.bass   = (melbands[0] + melbands[1]) * 0.5;
      _audio.mids   = (melbands[2] + melbands[3] + melbands[4]) / 3;
      _audio.treble = (melbands[6] + melbands[7]) * 0.5;
    }

    // [V5] Spectral flux — magnitude of spectrum change frame-to-frame
    if (freqData && freqData.length > 0) {
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const avgNorm = sum / (freqData.length * 255);
      const rawFlux = Math.abs(avgNorm - _prevFreqSum);
      _flux += (rawFlux * 8.0 - _flux) * 0.25;   // smooth, scale up to 0-1 range
      _audio.flux   = Math.min(_flux, 1.0);
      _prevFreqSum  = avgNorm;
    }
  }

  // ── GradientController sync ───────────────────────────────
  function _syncFromGradientController() {
    if (!window.GradientController) return;
    try {
      GradientController.frame(0.016);
      const g = GradientController.gfx;
      if (g.intensity > 1.0 || g.pulse > 0.0) {
        _audio.loudness = Math.max(0, g.intensity - 1.0);
        _audio.beat     = Math.max(_audio.beat, g.pulse);
        _audio.centroid = g.centroid || 0;
        _palShift       = (g.centroid || 0) * 60;
      }
    } catch (e) {}
  }

  // ── Public: song change ───────────────────────────────────
  function setSong(name, artist, token) {
    reset();
    if (!token) return;

    const API = window.ONESONG_API || 'https://onesong.onrender.com';
    fetch(
      `${API}/mood?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
      .then(r => r.ok ? r.json() : { tags: [] })
      .then(({ tags = [] }) => {
        const moodHues = {
          sad: 240, happy: 50, electronic: 280, chill: 160,
          rock: 10, pop: 320, jazz: 35, classical: 180,
          metal: 0, ambient: 200,
        };
        for (const tag of tags) {
          if (moodHues[tag] !== undefined) {
            _palShift = moodHues[tag];
            break;
          }
        }
        if (window.GradientController) {
          const hue = _palShift / 360;
          const top = [
            Math.cos(hue * Math.PI * 2) * 0.5 + 0.5,
            Math.sin(hue * Math.PI * 2) * 0.4 + 0.3,
            0.7 - hue * 0.3,
          ];
          GradientController.setBasePalette(top, [0.02, 0.02, 0.06]);
        }
      })
      .catch(() => {});
  }

  function startBeat() {
    if (window.GradientController) GradientController.updatePlayhead(0, true);
  }
  function stopBeat() {
    if (window.GradientController) GradientController.updatePlayhead(0, false);
  }
  function syncBeat() {
    _audio.beat = Math.min(1, _audio.beat + 0.8);
    if (window.GradientController) GradientController.triggerBeat();
  }

  function reset() {
    _audio.loudness = 0; _audio.centroid = 0;
    _audio.bass = 0; _audio.mids = 0;
    _audio.treble = 0; _audio.beat = 0; _audio.flux = 0;
    _bloomStr = 0; _shakeAmt = 0;
    _orbitT = 0; _shakeLFO_x = 0; _shakeLFO_y = 0;
    _flux = 0; _prevFreqSum = 0; _idleHue = 0;
    if (window.GradientController) GradientController.reset();
  }

  return { init, setSong, setAudioFeatures, startBeat, stopBeat, syncBeat, reset };
})();