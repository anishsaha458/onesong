/**
 * ambient.js — GPGPU Flow Field Visualizer  v6.0
 * ─────────────────────────────────────────────────────────────
 * COMPLETE REFACTOR of the GPGPU shader stack for distinct
 * per-band physical behaviour. Builds on all v5.0 improvements
 * (dual-curl, lifetime fade, camera orbit, density bias, etc.)
 *
 * ═══════════════════════════════════════════════════════════
 * NEW IN v6.0
 * ═══════════════════════════════════════════════════════════
 *
 * [S1] VELOCITY SHADER — BASS: EXPLOSION IMPULSE
 *      uBass is raw (no JS smoothing), so every kick drum fires
 *      an immediate radial shockwave. The impulse is:
 *        vel += normalize(pos) * uBass² * 8.0 * exp(-r*1.2)
 *      Squared so soft bass barely registers, loud kicks detonate.
 *      Separate from the existing beat uniform — uBass fires
 *      every frame proportional to energy, beat fires only on
 *      detected transients, giving two complementary effects.
 *
 * [S2] VELOCITY SHADER — MIDS: NOISE FREQUENCY MODULATION
 *      uMid modulates the curl noise SCALE parameter:
 *        scale = BASE_SCALE + uMid * MID_FREQ_RANGE
 *      Low mids → wide, slow vortices (thick honey swirl).
 *      High mids → tight, complex turbulence (busy synth texture).
 *      The secondary curl layer's scale is modulated 2× harder
 *      than primary, creating a frequency-dependent complexity gradient.
 *
 * [S3] VELOCITY SHADER — HIGHS: WHITE NOISE DISPLACEMENT
 *      uHigh adds a high-frequency stochastic displacement:
 *        vel.xyz += hash3(pos.xyz * 847.3 + u_time) * uHigh * JITTER_AMT
 *      The hash function is a single-pass 3D integer hash,
 *      faster than snoise() and produces uncorrelated jitter
 *      (true sparkle rather than coherent noise swirls).
 *      At uHigh≈0 particles flow smoothly; at uHigh≈1 they scatter
 *      like a cymbal shaking the fluid.
 *
 * [S4] POSITION SHADER — VISCOSITY DAMPING
 *      A dynamic damping factor simulates fluid viscosity:
 *        damping = mix(HONEY_DAMP, WATER_DAMP, uBass)
 *      HONEY_DAMP = 0.88  → heavy drag when bass is silent
 *      WATER_DAMP = 0.994 → near-frictionless during drops
 *      This makes quiet passages feel thick and heavy while
 *      drops explode into frictionless chaos.
 *
 * [S5] BLOOM — BASS-DRIVEN PULSE
 *      bloomPass.strength mapped directly to smoothed bass:
 *        strength = BASE_BLOOM + smoothBass * BASS_BLOOM_SCALE
 *      Uses a dedicated _smoothBloom accumulator with α=0.15
 *      so bloom pulses fast but doesn't strobe.
 *      Range: 0.3 (silence) → 2.8 (peak kick). The whole screen
 *      flashes white on a hard 808.
 *
 * [S6] COLOR — HIGH-FREQUENCY LUMINANCE ("white-hot")
 *      uHigh drives lightness in the vertex shader:
 *        lght = BASE_L + speed*0.25 + uHigh * 0.55
 *      At uHigh≈0: deep saturated colors (0.20–0.45 lightness)
 *      At uHigh≈1: particles blow out toward white (0.75+ lightness)
 *      The result: cymbal crashes bleach the field white-hot,
 *      then colors recover as highs decay.
 *
 * [S7] RETAINED from v5.0: dual-curl [V1], lifetime fade [V2],
 *      camera orbit [V3], spatial color bands [V4], spectral flux [V5],
 *      density bias [V6], idle hue drift [V7], half-res bloom [V8],
 *      adaptive throttle [V9], LFO shake [V10], color clamp [C1].
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

  // Camera orbit / shake
  let _orbitT      = 0;
  let _shakeLFO_x  = 0;
  let _shakeLFO_y  = 0;
  let _shakeAmt    = 0;

  // [S5] Dedicated bloom smoother — fast but not strobing
  let _smoothBloom = 0.3;

  // Adaptive throttle
  let _skipFrame = false;

  // Palette
  let _palHue  = 220;
  let _palShift = 0;
  let _idleHue  = 0;

  // Spectral flux
  let _prevFreqSum = 0;
  let _flux        = 0;

  // ── Audio state ───────────────────────────────────────────
  // [A1-A3] New per-band values fed from app.js
  const _audio = {
    loudness:  0,
    centroid:  0,
    beat:      0,
    // Legacy mel-derived (kept for GradientController compatibility)
    bass:      0,
    mids:      0,
    treble:    0,
    flux:      0,
    // [A2] NEW: true isolated bands from app.js
    uBass:     0,   // raw, instant
    uMid:      0,   // smoothed in app.js (α=0.12)
    uHigh:     0,   // smoothed in app.js (α=0.20)
  };

  // ── GLSL: 3D Simplex Noise (unchanged) ───────────────────
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

  // ── GLSL: Velocity Shader v6.0 ────────────────────────────
  //
  // [S1] uBass → radial explosion impulse (squared for headroom)
  // [S2] uMid  → curl noise FREQUENCY modulation (tighter swirls)
  // [S3] uHigh → integer hash white-noise jitter (sparkle/scatter)
  //
  const VELOCITY_SHADER = /* glsl */`
    ${GLSL_NOISE}

    uniform float u_time;
    uniform float u_dt;
    uniform float u_audioIntensity;
    uniform float u_beat;
    uniform float u_uBass;    // [S1] raw sub-bass energy
    uniform float u_uMid;     // [S2] smoothed mid energy
    uniform float u_uHigh;    // [S3] smoothed high energy
    // Legacy — kept for flux/centroid tint
    uniform float u_treble;
    uniform float u_flux;

    // ── [S3] Fast integer hash — uncorrelated 3D white noise ──
    // No trig, single multiply chain. Cheap and GPU-friendly.
    vec3 hash3(vec3 p) {
      p = fract(p * vec3(443.897, 441.423, 437.195));
      p += dot(p, p.yxz + 19.19);
      return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
    }

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      // ── [S2] MID-DRIVEN NOISE FREQUENCY ─────────────────
      // Base scale + uMid pushes from wide lazy vortices (0.55)
      // toward tight complex turbulence (1.85). Two layers
      // both modulated; secondary 2× harder (breaks repetition).
      float baseScale  = 0.55;
      float midFreqAdd = u_uMid * 1.30;              // 0 → 1.30 extra scale
      float scale1     = baseScale + midFreqAdd;
      float scale2     = scale1 * 2.3 + u_uMid * 1.20; // secondary scales harder

      // Curl intensity: audio loudness drives base field energy
      float intensity = 0.18 + u_audioIntensity * 1.2;

      // Primary curl layer
      vec3 p3    = vec3(pos.xy, pos.z + u_time * 0.08);
      vec3 curl1 = curlNoise(p3, scale1, intensity);

      // Secondary curl layer — offset phase, different time direction
      vec3 p3b   = vec3(pos.xy * 1.1 + vec2(17.3, 31.7), pos.z - u_time * 0.05 + 5.4);
      vec3 curl2 = curlNoise(p3b, scale2, intensity * 0.38);

      // Blend primary + secondary; uMid shifts weight to secondary
      float blend = 0.25 + u_uMid * 0.45;
      vec3 curl = mix(curl1, curl1 + curl2, blend);

      // Steer velocity toward curl field
      vec3 steering = (curl - vel.xyz) * u_dt * 3.5;
      vel.xyz += steering;

      // ── [S1] BASS: RADIAL EXPLOSION IMPULSE ─────────────
      // uBass is RAW (no JS smoothing) so kick fires this frame.
      // Squared: at 0.3 → 0.09 (weak), at 0.9 → 0.81 (strong).
      // exp(-r*1.2): concentrated at center, falls off quickly.
      float r     = length(pos.xyz);
      float bSq   = u_uBass * u_uBass;
      vel.xyz += normalize(pos.xyz + 0.0001)
               * bSq * 8.0
               * exp(-r * 1.2)
               * u_dt * 60.0;

      // Beat impulse — radial burst on detected transients
      float dist = length(pos.xy);
      vel.xy += normalize(pos.xy + 0.0001)
              * u_beat * 3.0
              * exp(-dist * 1.8)
              * u_dt * 60.0;

      // ── [S3] HIGH: WHITE-NOISE SPARKLE DISPLACEMENT ─────
      // hash3() gives a spatiotemporally unique jitter vector.
      // The time term makes it animate frame-to-frame (sparkle).
      // uHigh² keeps it subtle at low levels, explosive at peaks.
      float jitterStrength = u_uHigh * u_uHigh * 2.8;
      vec3  jitter = hash3(pos.xyz * 847.3 + vec3(u_time * 31.7, u_time * 17.3, u_time * 43.1));
      vel.xyz += jitter * jitterStrength * u_dt * 60.0;

      // Legacy treble coherent jitter (tamer, kept for texture blend)
      float legacyJitter = u_treble * 0.15;
      vel.xy += vec2(
        snoise(p3 * 4.2 + vec3(u_time * 0.3, 0., 0.)),
        snoise(p3 * 4.2 + vec3(0., u_time * 0.3, 0.))
      ) * legacyJitter;

      // ── SOFT BOUNDARY ────────────────────────────────────
      float boundaryFade = smoothstep(1.3, 1.7, r);
      vel.xyz -= normalize(pos.xyz) * boundaryFade * 0.6 * u_dt * 60.0;

      // Store curl magnitude in w for density bias [V6]
      gl_FragColor = vec4(vel.xyz, length(curl1));
    }
  `;

  // ── GLSL: Position Shader v6.0 ────────────────────────────
  //
  // [S4] VISCOSITY DAMPING: uBass controls fluid thickness.
  //      honey (low bass) ↔ water (high bass)
  //
  const POSITION_SHADER = /* glsl */`
    uniform float u_dt;
    uniform float u_time;
    uniform float u_uBass;   // [S4] raw bass — drives viscosity

    void main(){
      vec2 uv  = gl_FragCoord.xy / resolution.xy;
      vec4 pos = texture2D(tPosition, uv);
      vec4 vel = texture2D(tVelocity, uv);

      // ── [S4] VISCOSITY DAMPING ────────────────────────────
      // HONEY_DAMP=0.88: at silence every frame velocity is ×0.88
      //   → τ ≈ 8 frames → particles visibly slow, fluid looks thick
      // WATER_DAMP=0.994: near-frictionless → chaos persists, looks thin
      // uBass drives the mix, so drops feel physical.
      const float HONEY_DAMP = 0.880;
      const float WATER_DAMP = 0.994;
      float damping = mix(HONEY_DAMP, WATER_DAMP, clamp(u_uBass * 3.0, 0.0, 1.0));
      vel.xyz *= pow(damping, u_dt * 60.0);

      // Integrate position
      pos.xyz += vel.xyz * u_dt;

      // ── Lifetime management (V2) ──────────────────────────
      float age      = pos.w;
      float lifetime = 8.0 + fract(sin(dot(uv, vec2(127.1, 311.7))) * 43758.5) * 12.0;
      age += u_dt / lifetime;

      float r    = length(pos.xyz);
      bool oob   = r > 1.75;
      bool old   = age > 1.0;
      bool dead  = dot(vel.xyz, vel.xyz) < 1e-10;

      if(oob || old || dead){
        // Density-biased respawn [V6]
        float curlMag = vel.w;
        float bias    = mix(0.8, 0.3, clamp(curlMag * 0.4, 0.0, 1.0));

        float rng1 = fract(sin(dot(uv + u_time * 0.001, vec2(127.1, 311.7))) * 43758.5453);
        float rng2 = fract(sin(dot(uv + u_time * 0.001, vec2(269.5, 183.3))) * 43758.5453);
        float rng3 = fract(sin(dot(uv + u_time * 0.001, vec2(419.2, 371.9))) * 43758.5453);
        float th   = rng1 * 6.28318;
        float ph   = acos(2.0 * rng2 - 1.0);
        float rr   = bias * (0.15 + rng3 * 0.55);

        // Bass burst: kick pushes respawn radius out
        rr = mix(rr, rr * 1.4, u_uBass * 0.5);

        pos.xyz = vec3(sin(ph)*cos(th)*rr, sin(ph)*sin(th)*rr, cos(ph)*rr * 0.4);
        age = 0.0;
      }

      pos.w = age;
      gl_FragColor = pos;
    }
  `;

  // ── GLSL: Particle Vertex Shader v6.0 ────────────────────
  //
  // [S6] uHigh drives lightness — cymbal peaks make particles white-hot.
  //      At uHigh=0: lght ≈ 0.20–0.45 (deep saturated color)
  //      At uHigh=1: lght → 0.75 (near-white blow-out)
  //
  const PARTICLE_VERT = /* glsl */`
    uniform sampler2D tPosition;
    uniform sampler2D tVelocity;
    uniform float     u_audioIntensity;
    uniform float     u_uBass;
    uniform float     u_uMid;
    uniform float     u_uHigh;    // [S6] drives white-hot luminance
    uniform float     u_beat;
    uniform float     u_hue;
    uniform float     u_hueSecondary;
    uniform float     u_saturation;
    uniform float     u_flux;
    uniform float     u_time;

    varying vec3  vColor;
    varying float vAlpha;

    vec3 hsl2rgb(float h, float s, float l){
      h = mod(h, 360.0) / 360.0;
      float q = l < 0.5 ? l*(1.+s) : l+s-l*s;
      float p = 2.*l - q;
      vec3 rgb;
      float t;
      t = h + 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      rgb.r = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      t = h;         if(t<0.)t+=1.; if(t>1.)t-=1.;
      rgb.g = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      t = h - 1./3.; if(t<0.)t+=1.; if(t>1.)t-=1.;
      rgb.b = t<1./6.?p+(q-p)*6.*t : t<.5?q : t<2./3.?p+(q-p)*(2./3.-t)*6. : p;
      return rgb;
    }

    void main(){
      vec2 gpuUV = position.xy;
      vec4 pos   = texture2D(tPosition, gpuUV);
      vec4 vel   = texture2D(tVelocity, gpuUV);

      vec4 mvPos  = modelViewMatrix * vec4(pos.xyz, 1.0);
      gl_Position = projectionMatrix * mvPos;

      float spd = length(vel.xyz);

      // [S1] Bass expands particle size — kick puffs the cloud
      float sz = 1.1 + spd * 2.4 + u_uBass * 3.5 + u_beat * 2.5;
      gl_PointSize = sz * (300.0 / max(-mvPos.z, 0.5));

      // Lifetime fade [V2]
      float age     = pos.w;
      float fadeIn  = smoothstep(0.0, 0.08, age);
      float fadeOut = 1.0 - smoothstep(0.82, 1.0, age);
      float lifeFade = fadeIn * fadeOut;

      // Spatial hue blend [V4]
      float radial    = clamp(length(pos.xy) / 1.4, 0.0, 1.0);
      float hueCenter = u_hue + u_flux * 25.0;
      float hueEdge   = u_hueSecondary + pos.z * 20.0;
      float bandBlend = clamp(radial + u_uHigh * 0.3 - u_uBass * 0.3, 0.0, 1.0);
      float hue = mix(hueCenter, hueEdge, bandBlend);
      hue += spd * 30.0;

      // Saturation: mids add richness; base is generous
      float sat = 0.78 + u_saturation * 0.18 + u_uMid * 0.08;

      // ── [S6] WHITE-HOT LUMINANCE ──────────────────────────
      // Base: dark/saturated (0.20) → speed brings it up → highs blow out
      // The uHigh * 0.55 term is the key: at cymbal peaks the whole
      // field brightens toward 0.75 (near white with additive blending).
      float lght = 0.20
                 + spd        * 0.25
                 + u_audioIntensity * 0.08
                 + u_uMid     * 0.06
                 + u_uHigh    * 0.55;    // [S6] white-hot driver
      lght = clamp(lght, 0.10, 0.78);    // allow higher ceiling for highs

      vColor = hsl2rgb(hue, sat, lght);

      // Alpha: slightly boosted at high frequencies (particle visibility)
      float rawAlpha = clamp(0.12 + spd * 0.55 + u_audioIntensity * 0.30
                             + u_uHigh * 0.20, 0.03, 1.0);
      vAlpha = rawAlpha * lifeFade;
    }
  `;

  // ── GLSL: Particle Fragment Shader (unchanged) ────────────
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
      data[i*4+3] = Math.random();
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

    // Position shader uniforms
    Object.assign(posVar.material.uniforms, {
      u_dt:     { value: 0.016 },
      u_time:   { value: 0 },
      u_uBass:  { value: 0 },   // [S4] viscosity control
    });

    // Velocity shader uniforms — [S1-S3] new band uniforms
    Object.assign(velVar.material.uniforms, {
      u_dt:             { value: 0.016 },
      u_time:           { value: 0 },
      u_audioIntensity: { value: 0 },
      u_beat:           { value: 0 },
      u_uBass:          { value: 0 },   // [S1] explosion
      u_uMid:           { value: 0 },   // [S2] frequency modulation
      u_uHigh:          { value: 0 },   // [S3] white noise jitter
      u_treble:         { value: 0 },   // legacy coherent jitter
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
        u_uBass:          { value: 0 },
        u_uMid:           { value: 0 },
        u_uHigh:          { value: 0 },
        u_beat:           { value: 0 },
        u_hue:            { value: 220 },
        u_hueSecondary:   { value: 40 },
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
    console.info(`[Ambient] Init OK v6.0 ✓ — ${NUM_PARTICLES.toLocaleString()} particles`);
    _startLoop();
    return true;
  }

  // [V8] Half-res bloom
  function _setupComposer() {
    if (typeof THREE.EffectComposer === 'undefined' ||
        typeof THREE.UnrealBloomPass === 'undefined') {
      console.warn('[Ambient] EffectComposer/UnrealBloomPass not loaded');
      composer = null;
      return;
    }

    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));

    const bloomRes = new THREE.Vector2(
      Math.floor(innerWidth  * 0.5),
      Math.floor(innerHeight * 0.5),
    );
    // [S5] Starting strength is lower — bass will pump it up dramatically
    bloomPass = new THREE.UnrealBloomPass(bloomRes, 0.3, 0.35, 0.18);
    composer.addPass(bloomPass);
  }

  function _onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    if (bloomPass) {
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

      const dt = Math.min(clock.getDelta(), 0.05);
      const t  = clock.getElapsedTime();

      const uBass = _audio.uBass;
      const uMid  = _audio.uMid;
      const uHigh = _audio.uHigh;
      const loud  = _audio.loudness;
      const beat  = _audio.beat;
      const flux  = _audio.flux;

      // [V7] Idle hue drift
      const isActive = loud > 0.05 || uBass > 0.05;
      if (!isActive) {
        _idleHue = (_idleHue + dt * 3.0) % 360;
      }

      // ── [S5] BASS-DRIVEN BLOOM PULSE ──────────────────────
      // Uses a dedicated smoother (α=0.15) — fast but not strobing.
      // uBass is RAW so the smoother here is the only damping.
      // Range: 0.3 silence → up to 2.8 on a hard kick.
      _smoothBloom += (0.3 + uBass * 5.0 - _smoothBloom) * 0.15;
      const targetBloom = Math.max(0.3, Math.min(_smoothBloom, 2.8));

      // Camera shake: smooth LFO scaled by raw bass [V10]
      _shakeAmt += (uBass * 0.12 - _shakeAmt) * dt * 8;
      const lfoFreq = 3.0 + uBass * 4.0;
      _shakeLFO_x = Math.sin(t * lfoFreq * 3.0) * _shakeAmt;
      _shakeLFO_y = Math.cos(t * lfoFreq * 1.4) * _shakeAmt;

      // Hue tracking
      const hueTarget = isActive
        ? _audio.centroid * 360 + _palShift + flux * 30
        : 220 + _idleHue;
      _palHue += (hueTarget - _palHue) * dt * (isActive ? 1.2 : 0.3);
      const secondaryHue = _palHue + 150 + uBass * 40;

      // [V9] Adaptive compute throttle
      const energy    = loud + uBass * 0.3;
      const doCompute = energy > 0.04 || !_skipFrame;
      _skipFrame      = !_skipFrame;

      if (doCompute) {
        // Velocity shader uniforms
        velVar.material.uniforms.u_dt.value             = dt;
        velVar.material.uniforms.u_time.value           = t;
        velVar.material.uniforms.u_audioIntensity.value = loud;
        velVar.material.uniforms.u_beat.value           = beat;
        velVar.material.uniforms.u_uBass.value          = uBass;   // [S1]
        velVar.material.uniforms.u_uMid.value           = uMid;    // [S2]
        velVar.material.uniforms.u_uHigh.value          = uHigh;   // [S3]
        velVar.material.uniforms.u_treble.value         = _audio.treble;
        velVar.material.uniforms.u_flux.value           = flux;

        // Position shader uniforms
        posVar.material.uniforms.u_dt.value    = dt;
        posVar.material.uniforms.u_time.value  = t;
        posVar.material.uniforms.u_uBass.value = uBass;            // [S4]

        gpuCompute.compute();
      }

      // Particle material uniforms
      const mat = particlesMesh.material;
      mat.uniforms.tPosition.value        = gpuCompute.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.tVelocity.value        = gpuCompute.getCurrentRenderTarget(velVar).texture;
      mat.uniforms.u_audioIntensity.value = loud;
      mat.uniforms.u_uBass.value          = uBass;
      mat.uniforms.u_uMid.value           = uMid;
      mat.uniforms.u_uHigh.value          = uHigh;    // [S6]
      mat.uniforms.u_beat.value           = beat;
      mat.uniforms.u_hue.value            = _palHue;
      mat.uniforms.u_hueSecondary.value   = secondaryHue;
      mat.uniforms.u_saturation.value     = 0.5 + loud * 0.4 + uMid * 0.1;
      mat.uniforms.u_flux.value           = flux;
      mat.uniforms.u_time.value           = t;

      // [V3] Camera orbit — Lissajous figure-8
      _orbitT += dt * (0.06 + loud * 0.05);
      const orbitR = 0.18 + uBass * 0.18;
      const orbitX = Math.sin(_orbitT * 1.0) * orbitR;
      const orbitY = Math.sin(_orbitT * 2.0) * orbitR * 0.55;
      camera.position.x = orbitX + _shakeLFO_x;
      camera.position.y = orbitY + _shakeLFO_y;
      camera.lookAt(0, 0, 0);

      // [S5] Apply bass-driven bloom strength
      if (bloomPass) {
        bloomPass.strength = targetBloom;
      }

      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }

      // Decay beat impulse
      _audio.beat *= 0.72;
    })();
  }

  // ── Public: audio feature input ──────────────────────────
  // Accepts the new uBass/uMid/uHigh from app.js v6.0.
  // Falls back gracefully if old keys are passed (backward-compat).
  function setAudioFeatures({
    loudness  = 0,
    centroid  = 0,
    melbands  = null,
    beat      = 0,
    freqData  = null,
    uBass     = 0,
    uMid      = 0,
    uHigh     = 0,
  } = {}) {
    _audio.loudness = loudness;
    _audio.centroid = centroid;
    _audio.beat     = Math.max(_audio.beat, beat);

    // [A2] Direct per-band assignment — these come pre-processed from app.js
    _audio.uBass = uBass;
    _audio.uMid  = uMid;
    _audio.uHigh = uHigh;

    // Mel-derived bands kept for GradientController / legacy paths
    if (melbands && melbands.length >= 8) {
      _audio.bass   = (melbands[0] + melbands[1]) * 0.5;
      _audio.mids   = (melbands[2] + melbands[3] + melbands[4]) / 3;
      _audio.treble = (melbands[6] + melbands[7]) * 0.5;
    }

    // [V5] Spectral flux
    if (freqData && freqData.length > 0) {
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const avgNorm = sum / (freqData.length * 255);
      const rawFlux = Math.abs(avgNorm - _prevFreqSum);
      _flux += (rawFlux * 8.0 - _flux) * 0.25;
      _audio.flux  = Math.min(_flux, 1.0);
      _prevFreqSum = avgNorm;
    }
  }

  // ── Public: song change ───────────────────────────────────
  function setSong(name, artist, token) {
    reset();
    if (!token) return;

    const _API = window.ONESONG_API || 'https://onesong.onrender.com';
    fetch(
      `${_API}/mood?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`,
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
    _audio.bass = 0; _audio.mids = 0; _audio.treble = 0;
    _audio.beat = 0; _audio.flux = 0;
    _audio.uBass = 0; _audio.uMid = 0; _audio.uHigh = 0;
    _smoothBloom = 0.3; _shakeAmt = 0;
    _orbitT = 0; _shakeLFO_x = 0; _shakeLFO_y = 0;
    _flux = 0; _prevFreqSum = 0; _idleHue = 0; _palShift = 0;
    if (window.GradientController) GradientController.reset();
  }

  return { init, setSong, setAudioFeatures, startBeat, stopBeat, syncBeat, reset };
})();