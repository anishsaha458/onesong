/**
 * ambient.js — GPGPU Flow Field Visualizer  v4.0
 * ─────────────────────────────────────────────────────────────
 * Three.js r128 + GPUComputationRenderer + EffectComposer + UnrealBloomPass
 *
 * Architecture:
 *   GPUComputationRenderer handles tPosition + tVelocity ping-pong internally.
 *   THREE.HalfFloatType for ALL textures — universal browser/GPU support.
 *   EffectComposer → RenderPass → UnrealBloomPass for neon glow.
 *
 * Audio reactivity (two layers):
 *   ESSENTIA JSON timeline  → flow strength (loudness), color hue (spectral centroid)
 *   Web Audio API real-time → kick bass → camera shake + bloom, hats → jitter
 *
 * Black screen fixes vs v3.x:
 *   • renderer alpha:true so canvas is truly transparent (body/html CSS shows through)
 *   • GPGPU loop starts immediately on init(), not gated behind login
 *   • GPUComputationRenderer explicitly sets useHalfFloat on all vars
 *   • EffectComposer renders to screen — no manual final-composite shader needed
 */

const Ambient = (() => {

  // ── Constants ─────────────────────────────────────────────
  const PARTICLE_TEXTURE_SIZE = 256;     // 256×256 = 65 536 particles
  const NUM_PARTICLES = PARTICLE_TEXTURE_SIZE * PARTICLE_TEXTURE_SIZE;

  // ── Module state ──────────────────────────────────────────
  let renderer, scene, camera, clock;
  let gpuCompute;
  let posVar, velVar;                    // GPUComputationRenderer variables
  let particlesMesh;
  let composer, bloomPass;
  let initialized = false;
  let rafId = null;

  // ── Palette ───────────────────────────────────────────────
  let _palHue   = 220;                   // degrees, driven by spectral centroid
  let _palShift = 0;

  // ── Audio uniforms (written by app.js via setAudioFeatures) ─
  const _audio = {
    loudness:  0,    // 0-1 RMS loudness (Essentia + Web Audio)
    centroid:  0,    // 0-1 spectral centroid → color hue
    bass:      0,    // 0-1 low-freq energy → camera shake, bloom
    treble:    0,    // 0-1 high-freq energy → particle jitter
    beat:      0,    // 0-1 beat pulse
  };

  // ── Camera shake state ────────────────────────────────────
  let _shakeAmt   = 0;
  let _bloomStr   = 0;

  // ── GLSL: 3D Simplex Noise (self-contained, no deps) ─────
  const GLSL_NOISE = /* glsl */`
    //  Simplex 3D noise by Ashima Arts / Stefan Gustavson
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

    // 3D Curl Noise — divergence-free vector field
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
  // Curl noise drives the flow field.
  // u_audioIntensity (loudness) scales both noise frequency and influence.
  // u_treble adds high-frequency jitter.
  // u_beat fires a radial impulse.
  const VELOCITY_SHADER = /* glsl */`
    ${GLSL_NOISE}

    uniform float u_time;
    uniform float u_dt;
    uniform float u_audioIntensity;  // 0-1 loudness → flow strength
    uniform float u_beat;            // 0-1 beat pulse → radial impulse
    uniform float u_treble;          // 0-1 high freq → jitter
    uniform float u_bass;            // 0-1 low freq  → field expansion

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      float intensity = 0.18 + u_audioIntensity * 1.4 + u_bass * 0.6;
      float scale     = 0.55 + u_audioIntensity * 1.2;

      // Animated 3D curl noise field
      vec3 p3 = vec3(pos.xy, pos.z + u_time * 0.08);
      vec3 curl = curlNoise(p3, scale, intensity);

      // High-frequency jitter (treble)
      float jitter = u_treble * 0.35;
      curl.xy += vec2(
        snoise(p3 * 4.2 + vec3(u_time * 0.3, 0., 0.)),
        snoise(p3 * 4.2 + vec3(0., u_time * 0.3, 0.))
      ) * jitter;

      // Steer velocity toward curl field
      vec3 steering = (curl - vel.xyz) * u_dt * 3.5;
      vel.xyz += steering;

      // Beat impulse — radial outward burst
      float dist = length(pos.xy);
      vel.xy += normalize(pos.xy + 0.0001) * u_beat * 2.2 * exp(-dist * 1.8) * u_dt * 60.0;

      // Damping
      vel.xyz *= 0.982;

      // Soft boundary spring — pull back if too far
      float r = length(pos.xyz);
      if(r > 1.5) vel.xyz -= normalize(pos.xyz) * (r - 1.5) * 0.8 * u_dt * 60.0;

      // Store speed in w for use in rendering
      gl_FragColor = vec4(vel.xyz, length(vel.xyz));
    }
  `;

  // ── GLSL: Position shader ─────────────────────────────────
  // Particles flow along velocity field and wrap around screen boundaries.
  const POSITION_SHADER = /* glsl */`
    uniform float u_dt;
    uniform float u_time;

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      // Integrate position
      pos.xyz += vel.xyz * u_dt;

      // Toroidal wrap in XY — particles flow across screen boundaries
      // Z wraps on a tighter range (depth)
      if(pos.x >  1.8) pos.x -= 3.6;
      if(pos.x < -1.8) pos.x += 3.6;
      if(pos.y >  1.8) pos.y -= 3.6;
      if(pos.y < -1.8) pos.y += 3.6;
      if(pos.z >  1.2) pos.z -= 2.4;
      if(pos.z < -1.2) pos.z += 2.4;

      // Respawn dead particles (stopped)
      if(dot(vel.xyz, vel.xyz) < 1e-10){
        // Hash-based pseudorandom respawn from UV
        float rng1 = fract(sin(dot(uv, vec2(127.1, 311.7))) * 43758.5453);
        float rng2 = fract(sin(dot(uv, vec2(269.5, 183.3))) * 43758.5453);
        float rng3 = fract(sin(dot(uv, vec2(419.2, 371.9))) * 43758.5453);
        float th = rng1 * 6.28318;
        float ph = acos(2.0 * rng2 - 1.0);
        float r  = 0.1 + rng3 * 0.9;
        pos.xyz  = vec3(sin(ph)*cos(th)*r, sin(ph)*sin(th)*r, cos(ph)*r * 0.5);
      }

      // Store lifetime in w
      pos.w = mod(pos.w + u_dt, 100.0);
      gl_FragColor = pos;
    }
  `;

  // ── GLSL: Particle vertex shader ──────────────────────────
  const PARTICLE_VERT = /* glsl */`
    uniform sampler2D tPosition;
    uniform sampler2D tVelocity;
    uniform float     u_audioIntensity;
    uniform float     u_bass;
    uniform float     u_beat;
    uniform float     u_hue;          // 0-360 driven by spectral centroid
    uniform float     u_saturation;   // driven by loudness
    uniform float     u_time;

    varying vec3  vColor;
    varying float vAlpha;

    // HSL → RGB (GLSL, fast)
    vec3 hsl2rgb(float h, float s, float l){
      h = mod(h, 360.0) / 360.0;
      float r, g, b;
      float q = l < 0.5 ? l*(1.+s) : l+s-l*s;
      float p = 2.*l - q;
      float hk = h;
      // Red
      float t = hk + 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      r = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      // Green
      t = hk; if(t<0.)t+=1.; if(t>1.)t-=1.;
      g = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      // Blue
      t = hk - 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      b = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      return vec3(r, g, b);
    }

    void main(){
      // UV into GPGPU texture
      vec2 gpuUV = position.xy;
      vec4 pos   = texture2D(tPosition, gpuUV);
      vec4 vel   = texture2D(tVelocity, gpuUV);

      vec4 mvPos    = modelViewMatrix * vec4(pos.xyz, 1.0);
      gl_Position   = projectionMatrix * mvPos;

      // Point size — bass expands, beat pulses
      float spd    = vel.w;
      float sz     = 1.2 + spd * 2.8 + u_bass * 3.0 + u_beat * 2.5;
      gl_PointSize = sz * (300.0 / max(-mvPos.z, 0.5));

      // Color — HSL driven by spectral centroid (hue) and loudness (saturation)
      float hue  = u_hue + pos.z * 30.0 + spd * 40.0;   // depth + speed tint
      float sat  = 0.6 + u_saturation * 0.4;
      float lght = 0.35 + spd * 0.5 + u_audioIntensity * 0.3;
      vColor = hsl2rgb(hue, sat, clamp(lght, 0.1, 0.9));

      // Alpha — faster = more opaque
      vAlpha = clamp(0.15 + spd * 0.6 + u_audioIntensity * 0.4, 0.04, 1.0);
    }
  `;

  // ── GLSL: Particle fragment shader ────────────────────────
  const PARTICLE_FRAG = /* glsl */`
    varying vec3  vColor;
    varying float vAlpha;

    void main(){
      // Soft circular point
      float d = length(gl_PointCoord - vec2(0.5));
      if(d > 0.5) discard;
      float edge = 1.0 - d * 2.0;
      float glow = pow(edge, 1.4);
      gl_FragColor = vec4(vColor * (1.0 + glow * 0.6), glow * glow * vAlpha);
    }
  `;

  // ── Helper: fill Float32Array with sphere distribution ───
  function _sphereData(n) {
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 0.1 + Math.random() * 1.0;
      data[i*4]   = Math.sin(ph) * Math.cos(th) * r;
      data[i*4+1] = Math.sin(ph) * Math.sin(th) * r;
      data[i*4+2] = Math.cos(ph) * r * 0.4;
      data[i*4+3] = Math.random() * 100;   // random lifetime offset
    }
    return data;
  }

  // ── Public API: init ─────────────────────────────────────
  function init() {
    if (initialized) return true;

    const canvas = document.getElementById('ambient-canvas');
    if (!canvas) { console.error('[Ambient] #ambient-canvas not found'); return false; }

    // Canvas must sit behind all UI
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0',
      width: '100vw', height: '100vh',
      zIndex: '-1', display: 'block', pointerEvents: 'none',
    });

    // ── Renderer ─────────────────────────────────────────────
    // alpha:true → canvas is transparent so body/html gradient shows through.
    // This is the primary fix for the black screen when no particles are visible.
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias:        false,
        alpha:            true,          // ← transparent canvas background
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
    renderer.setClearColor(0x000000, 0);  // fully transparent clear

    // ── Check GPU capability ──────────────────────────────────
    const gl = renderer.getContext();
    const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined')
      && (gl instanceof WebGL2RenderingContext);
    const hasHF  = isWebGL2 || !!gl.getExtension('OES_texture_half_float');
    const hasF   = isWebGL2 || !!gl.getExtension('OES_texture_float');

    if (!hasHF && !hasF) {
      console.warn('[Ambient] No float texture support — CSS fallback');
      _cssFallback(canvas);
      return false;
    }
    console.info(`[Ambient] WebGL${isWebGL2 ? '2' : '1'} ✓  HalfFloat:${hasHF}  Float:${hasF}`);

    // ── Scene + Camera ────────────────────────────────────────
    scene  = new THREE.Scene();
    clock  = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
    camera.position.z = 2.8;

    // ── GPUComputationRenderer ────────────────────────────────
    // Library loaded from jsdelivr before this script.
    // GPUComputationRenderer handles double-buffered FBO ping-pong internally.
    if (typeof THREE.GPUComputationRenderer === 'undefined') {
      console.error('[Ambient] GPUComputationRenderer not loaded. Add the script tag.');
      _cssFallback(canvas);
      return false;
    }

    const SIZE = PARTICLE_TEXTURE_SIZE;
    gpuCompute = new THREE.GPUComputationRenderer(SIZE, SIZE, renderer);

    // Force HalfFloat on all GPGPU textures — the only type with universal
    // render-target support across WebGL1/2 and all GPU vendors.
    gpuCompute.setDataType(THREE.HalfFloatType);

    // Seed textures
    const initPos = gpuCompute.createTexture();
    const initVel = gpuCompute.createTexture();
    const posData = _sphereData(SIZE * SIZE);
    initPos.image.data.set(posData);
    // Velocity starts at zero — particles will be immediately driven by curl noise

    // Add variables (shaders)
    posVar = gpuCompute.addVariable('tPosition', POSITION_SHADER, initPos);
    velVar = gpuCompute.addVariable('tVelocity', VELOCITY_SHADER, initVel);

    // Cross-dependencies (position reads velocity, velocity reads position)
    gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
    gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

    // Uniforms for position shader
    Object.assign(posVar.material.uniforms, {
      u_dt:   { value: 0.016 },
      u_time: { value: 0 },
    });

    // Uniforms for velocity shader
    Object.assign(velVar.material.uniforms, {
      u_dt:             { value: 0.016 },
      u_time:           { value: 0 },
      u_audioIntensity: { value: 0 },
      u_beat:           { value: 0 },
      u_treble:         { value: 0 },
      u_bass:           { value: 0 },
    });

    const err = gpuCompute.init();
    if (err !== null) {
      console.error('[Ambient] GPUComputationRenderer init error:', err);
      _cssFallback(canvas);
      return false;
    }

    // ── Particle geometry + material ──────────────────────────
    // UV coordinates into the GPGPU texture, stored as position attribute
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
        u_beat:           { value: 0 },
        u_hue:            { value: 220 },
        u_saturation:     { value: 0.5 },
        u_time:           { value: 0 },
      },
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,   // neon/glow additive blend
      depthWrite:     false,
      depthTest:      false,
    });

    particlesMesh = new THREE.Points(geo, mat);
    scene.add(particlesMesh);

    // ── EffectComposer + UnrealBloomPass ──────────────────────
    _setupComposer();

    // ── Resize handler ────────────────────────────────────────
    window.addEventListener('resize', _onResize);

    initialized = true;
    console.info(`[Ambient] Init OK ✓ — ${NUM_PARTICLES.toLocaleString()} particles, Bloom active`);
    _startLoop();
    return true;
  }

  function _setupComposer() {
    if (typeof THREE.EffectComposer === 'undefined' ||
        typeof THREE.UnrealBloomPass === 'undefined') {
      console.warn('[Ambient] EffectComposer/UnrealBloomPass not loaded — rendering without bloom');
      composer = null;
      return;
    }

    composer = new THREE.EffectComposer(renderer);

    const renderPass = new THREE.RenderPass(scene, camera);
    composer.addPass(renderPass);

    // UnrealBloomPass(resolution, strength, radius, threshold)
    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      0.9,    // strength  — boosted by bass at runtime
      0.4,    // radius
      0.0,    // threshold — low so dim particles still glow
    );
    composer.addPass(bloomPass);
  }

  function _onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(w, h);
  }

  // ── CSS fallback for no-WebGL environments ────────────────
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

      const dt = Math.min(clock.getDelta(), 0.05);
      const t  = clock.getElapsedTime();

      // Smooth audio values toward targets
      const targetLoud   = _audio.loudness;
      const targetBass   = _audio.bass;
      const targetTreble = _audio.treble;
      const targetBeat   = _audio.beat;

      // Lerp bloom strength toward bass-driven target
      _bloomStr  += (0.6 + targetBass * 2.2 - _bloomStr)  * dt * 4;
      _shakeAmt  += (targetBass * 0.012         - _shakeAmt) * dt * 8;
      _palHue    += (_audio.centroid * 360 + _palShift - _palHue) * dt * 0.8;

      // ── Update GPGPU ────────────────────────────────────────
      // Velocity shader uniforms
      velVar.material.uniforms.u_dt.value             = dt;
      velVar.material.uniforms.u_time.value           = t;
      velVar.material.uniforms.u_audioIntensity.value = targetLoud;
      velVar.material.uniforms.u_beat.value           = targetBeat;
      velVar.material.uniforms.u_treble.value         = targetTreble;
      velVar.material.uniforms.u_bass.value           = targetBass;

      // Position shader uniforms
      posVar.material.uniforms.u_dt.value   = dt;
      posVar.material.uniforms.u_time.value = t;

      gpuCompute.compute();

      // ── Update particle material ────────────────────────────
      const mat = particlesMesh.material;
      mat.uniforms.tPosition.value        = gpuCompute.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.tVelocity.value        = gpuCompute.getCurrentRenderTarget(velVar).texture;
      mat.uniforms.u_audioIntensity.value = targetLoud;
      mat.uniforms.u_bass.value           = targetBass;
      mat.uniforms.u_beat.value           = targetBeat;
      mat.uniforms.u_hue.value            = _palHue;
      mat.uniforms.u_saturation.value     = 0.5 + targetLoud * 0.5;
      mat.uniforms.u_time.value           = t;

      // ── Camera shake (bass-driven) ──────────────────────────
      camera.position.x = (Math.random() - 0.5) * _shakeAmt;
      camera.position.y = (Math.random() - 0.5) * _shakeAmt;

      // ── Bloom intensity (bass-driven) ───────────────────────
      if (bloomPass) {
        bloomPass.strength = Math.max(0.3, _bloomStr);
      }

      // ── Render ──────────────────────────────────────────────
      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }

      // Decay beat impulse
      _audio.beat *= 0.88;

    })();
  }

  // ── Public: audio data feed ───────────────────────────────
  // Called by app.js every 250ms (clockPoller) with real-time Web Audio data,
  // and by GradientController integration with Essentia timeline data.
  function setAudioFeatures({ loudness = 0, centroid = 0, melbands = null, beat = 0 } = {}) {
    _audio.loudness = loudness;
    _audio.centroid = centroid;
    _audio.beat     = Math.max(_audio.beat, beat);   // latch peak, decay in loop

    if (melbands && melbands.length >= 8) {
      // Low 2 bands = bass (kicks)
      _audio.bass   = (melbands[0] + melbands[1]) * 0.5;
      // High 2 bands = treble (hats, cymbals)
      _audio.treble = (melbands[6] + melbands[7]) * 0.5;
    }
  }

  // ── Public: GradientController integration ────────────────
  // Called from the render loop if GradientController is available.
  // Reads the Essentia JSON timeline data that GradientController interpolates.
  function _syncFromGradientController() {
    if (!window.GradientController) return;
    try {
      GradientController.frame(0.016);
      const g = GradientController.gfx;
      if (g.intensity > 1.0 || g.pulse > 0.0) {
        _audio.loudness = Math.max(0, g.intensity - 1.0);
        _audio.beat     = Math.max(_audio.beat, g.pulse);
        _audio.centroid = g.centroid || 0;
        _palShift       = (g.centroid || 0) * 60;  // hue shift from Essentia
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
        // Map mood tags to base hue
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
            Math.cos(hue * Math.PI * 2) * 0.4 + 0.5,
            Math.sin(hue * Math.PI * 2) * 0.2 + 0.3,
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
    _audio.loudness = 0;
    _audio.centroid = 0;
    _audio.bass     = 0;
    _audio.treble   = 0;
    _audio.beat     = 0;
    _bloomStr       = 0;
    _shakeAmt       = 0;
    if (window.GradientController) GradientController.reset();
  }

  return { init, setSong, setAudioFeatures, startBeat, stopBeat, syncBeat, reset };
})();