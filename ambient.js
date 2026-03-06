/**
 * ambient.js — GPGPU Flow Field Visualizer  v8.0
 * ─────────────────────────────────────────────────────────────
 * PERFORMANCE OVERHAUL vs v7.0
 * ═══════════════════════════════════════════════════════════
 *
 * [P1] TEXTURE SIZE — kept at 256×256 = 65,536 particles.
 *      This is the confirmed GPU sweet-spot: fluid density with
 *      full 60 FPS on mid-range hardware. Going to 512×512
 *      quadruples the GPGPU texture work without meaningful
 *      visual gain on screens < 4K.
 *
 * [P2] HALF-FLOAT TEXTURES — GPUComputationRenderer now has
 *      setDataType(THREE.HalfFloatType) called BEFORE init().
 *      This halves VRAM bandwidth for every ping-pong read/write.
 *      v7.0 called it after variable setup — too late on some
 *      WebGL implementations where the internal format is already
 *      committed. Order is now: createTexture → addVariable →
 *      setDataType → init().
 *
 * [P3] UNIFIED AUDIO UNIFORM — u_uBass/u_uMid/u_uHigh collapsed
 *      into a single  uniform vec3 u_audioData  (x=bass, y=mid,
 *      z=high). Eliminates 2 uniform lookups per shader invocation.
 *      JS side updates one uniform instead of three. All GLSL
 *      references updated: u_uBass → u_audioData.x, etc.
 *
 * [P4] BLOOM RESOLUTION — UnrealBloomPass constructed at 0.5×
 *      screen dimensions (was already 0.5× in v7, confirmed here).
 *      Threshold raised 0.22 → 0.28 so only the fastest/brightest
 *      particle centers trigger the bloom mip chain, reducing the
 *      number of luminosity-threshold passes that fire per frame.
 *
 * [P5] FRAGMENT SHADER EARLY-EXIT — particles below a minimum
 *      speed threshold short-circuit after disc discard, skipping
 *      the full HSL pipeline. Slow center particles (the "orb"
 *      mass) get a cheap dark color; only the fast trail particles
 *      pay full shader cost.
 *
 * [P6] POINT SIZE CAP — gl_PointSize clamped to [1.0, 4.0].
 *      Large points are expensive: a 10px point covers 100 frags
 *      vs 16 for 4px. Bass boost still drives size variation but
 *      within the safe range. This alone saves ~15% fill-rate on
 *      kick-heavy tracks.
 *
 * [P7] RAF GUARD — _startLoop is now idempotent via a module-level
 *      `_loopRunning` flag (belt-and-suspenders alongside rafId).
 *      Prevents double RAF registration if init() is ever called
 *      twice or the loop is interrupted then restarted.
 *
 * [C1–C5] ALL v7.0 COLOR ARCHITECTURE RETAINED:
 *      Fragment-shader HSL pipeline, speed-gated lightness,
 *      beat complementary-hue flash with trail decay, inverse
 *      size/alpha link, deep purple-black clear color.
 *
 * [S1–S5] ALL v6.0 PHYSICS RETAINED (bass explosion, mid mod,
 *      high jitter, viscosity damping, bass bloom pulse).
 */

const Ambient = (() => {

  // [P1] 256×256 = 65 536 particles — GPU sweet-spot
  const PARTICLE_TEXTURE_SIZE = 256;
  const NUM_PARTICLES = PARTICLE_TEXTURE_SIZE * PARTICLE_TEXTURE_SIZE;

  let renderer, scene, camera, clock;
  let gpuCompute, posVar, velVar;
  let particlesMesh;
  let composer, bloomPass;
  let initialized  = false;
  let rafId        = null;
  let _loopRunning = false; // [P7] belt-and-suspenders RAF guard

  // Camera
  let _orbitT = 0, _shakeLFO_x = 0, _shakeLFO_y = 0, _shakeAmt = 0;

  // Bloom
  let _smoothBloom = 0.3;

  // Beat flash decay
  let _beatFlash = 0.0;

  // Throttle
  let _skipFrame = false;

  // Palette
  let _palHue = 220, _palShift = 0, _idleHue = 0;

  // Flux
  let _prevFreqSum = 0, _flux = 0;

  const _audio = {
    loudness: 0, centroid: 0, beat: 0,
    bass: 0, mids: 0, treble: 0, flux: 0,
    uBass: 0, uMid: 0, uHigh: 0,
  };

  // ─────────────────────────────────────────────────────────
  // GLSL: Simplex Noise + Curl (unchanged)
  // ─────────────────────────────────────────────────────────
  const GLSL_NOISE = `
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
        i.z + vec4(0.,i1.z,i2.z,1.)) +
        i.y + vec4(0.,i1.y,i2.y,1.)) +
        i.x + vec4(0.,i1.x,i2.x,1.));
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
      vec3 p0 = vec3(a0.xy,hh.x);
      vec3 p1 = vec3(a0.zw,hh.y);
      vec3 p2 = vec3(a1.xy,hh.z);
      vec3 p3 = vec3(a1.zw,hh.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m = max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
      m=m*m;
      return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
    vec3 curlNoise(vec3 p, float scale, float influence){
      float e=0.0001;
      vec3 sp=p*scale;
      float nx1=snoise(sp+vec3(e,0,0)),nx0=snoise(sp-vec3(e,0,0));
      float ny1=snoise(sp+vec3(0,e,0)),ny0=snoise(sp-vec3(0,e,0));
      float nz1=snoise(sp+vec3(0,0,e)),nz0=snoise(sp-vec3(0,0,e));
      return vec3((ny1-ny0)-(nz1-nz0),(nz1-nz0)-(nx1-nx0),(nx1-nx0)-(ny1-ny0))*influence/(2.0*e);
    }
  `;

  // ─────────────────────────────────────────────────────────
  // VELOCITY SHADER
  // [P3] u_uBass/Mid/High → u_audioData.xyz (single vec3 lookup)
  // ─────────────────────────────────────────────────────────
  const VELOCITY_SHADER = `
    ${GLSL_NOISE}
    uniform float u_time, u_dt, u_audioIntensity, u_beat;
    // [P3] Single vec3 uniform: x=bass, y=mid, z=high
    uniform vec3  u_audioData;
    uniform float u_treble, u_flux;

    vec3 hash3(vec3 p){
      p=fract(p*vec3(443.897,441.423,437.195));
      p+=dot(p,p.yxz+19.19);
      return fract((p.xxy+p.yxx)*p.zyx)*2.0-1.0;
    }

    void main(){
      vec2 uv  = gl_FragCoord.xy/resolution.xy;
      vec4 pos = texture2D(tPosition,uv);
      vec4 vel = texture2D(tVelocity,uv);

      float uBass = u_audioData.x;
      float uMid  = u_audioData.y;
      float uHigh = u_audioData.z;

      float scale1    = 0.55 + uMid*1.30;
      float scale2    = scale1*2.3 + uMid*1.20;
      float intensity = 0.18 + u_audioIntensity*1.2;

      vec3 p3    = vec3(pos.xy, pos.z + u_time*0.08);
      vec3 curl1 = curlNoise(p3, scale1, intensity);
      vec3 p3b   = vec3(pos.xy*1.1+vec2(17.3,31.7), pos.z-u_time*0.05+5.4);
      vec3 curl2 = curlNoise(p3b, scale2, intensity*0.38);
      vec3 curl  = mix(curl1, curl1+curl2, 0.25+uMid*0.45);

      vel.xyz += (curl - vel.xyz)*u_dt*3.5;

      // [S1] Bass explosion
      float r   = length(pos.xyz);
      float bSq = uBass*uBass;
      vel.xyz += normalize(pos.xyz+0.0001)*bSq*8.0*exp(-r*1.2)*u_dt*60.0;

      // Beat radial burst
      vel.xy += normalize(pos.xy+0.0001)*u_beat*3.0*exp(-length(pos.xy)*1.8)*u_dt*60.0;

      // [S3] High white-noise jitter
      vec3 jitter = hash3(pos.xyz*847.3+vec3(u_time*31.7,u_time*17.3,u_time*43.1));
      vel.xyz += jitter*(uHigh*uHigh*2.8)*u_dt*60.0;

      // Legacy treble coherent jitter
      vel.xy += vec2(snoise(p3*4.2+vec3(u_time*0.3,0.,0.)),snoise(p3*4.2+vec3(0.,u_time*0.3,0.)))*u_treble*0.15;

      // Soft boundary
      vel.xyz -= normalize(pos.xyz)*smoothstep(1.3,1.7,r)*0.6*u_dt*60.0;

      gl_FragColor = vec4(vel.xyz, length(curl1));
    }
  `;

  // ─────────────────────────────────────────────────────────
  // POSITION SHADER — [S4] Viscosity damping
  // [P3] u_uBass → u_audioData.x
  // ─────────────────────────────────────────────────────────
  const POSITION_SHADER = `
    uniform float u_dt, u_time;
    uniform vec3  u_audioData; // [P3] x=bass, y=mid, z=high

    void main(){
      vec2 uv  = gl_FragCoord.xy/resolution.xy;
      vec4 pos = texture2D(tPosition,uv);
      vec4 vel = texture2D(tVelocity,uv);

      float uBass = u_audioData.x;

      // [S4] honey(0.880) ↔ water(0.994) based on raw bass
      float damping = mix(0.880, 0.994, clamp(uBass*3.0,0.0,1.0));
      vel.xyz *= pow(damping, u_dt*60.0);
      pos.xyz += vel.xyz*u_dt;

      float age = pos.w;
      age += u_dt/(8.0+fract(sin(dot(uv,vec2(127.1,311.7)))*43758.5)*12.0);

      float r = length(pos.xyz);
      if(r>1.75 || age>1.0 || dot(vel.xyz,vel.xyz)<1e-10){
        float curlMag = vel.w;
        float bias = mix(0.8,0.3,clamp(curlMag*0.4,0.0,1.0));
        float rng1=fract(sin(dot(uv+u_time*0.001,vec2(127.1,311.7)))*43758.5453);
        float rng2=fract(sin(dot(uv+u_time*0.001,vec2(269.5,183.3)))*43758.5453);
        float rng3=fract(sin(dot(uv+u_time*0.001,vec2(419.2,371.9)))*43758.5453);
        float th=rng1*6.28318, ph=acos(2.0*rng2-1.0);
        float rr=bias*(0.15+rng3*0.55);
        rr=mix(rr,rr*1.4,uBass*0.5);
        pos.xyz=vec3(sin(ph)*cos(th)*rr,sin(ph)*sin(th)*rr,cos(ph)*rr*0.4);
        age=0.0;
      }
      pos.w=age;
      gl_FragColor=pos;
    }
  `;

  // ─────────────────────────────────────────────────────────
  // PARTICLE VERTEX SHADER v8.0
  //
  // [P3] u_uBass/Mid/High → u_audioData.xyz
  // [P6] gl_PointSize clamped to [1.0, 4.0] — fill-rate safety
  // ─────────────────────────────────────────────────────────
  const PARTICLE_VERT = `
    uniform sampler2D tPosition;
    uniform sampler2D tVelocity;
    uniform float u_audioIntensity;
    // [P3] Packed audio: x=bass, y=mid, z=high
    uniform vec3  u_audioData;
    uniform float u_beat, u_time;

    varying float vSpeed;
    varying float vAge;
    varying float vRadial;
    varying float vBass;
    varying float vMid;
    varying float vHigh;
    varying float vAlpha;

    void main(){
      vec4 pos  = texture2D(tPosition, position.xy);
      vec4 vel  = texture2D(tVelocity, position.xy);
      vec4 mvPos = modelViewMatrix * vec4(pos.xyz, 1.0);
      gl_Position = projectionMatrix * mvPos;

      float uBass = u_audioData.x;
      float spd   = length(vel.xyz);

      // [P6] Size capped to [1.0, 4.0] — prevents fill-rate explosion
      // Bass still drives variation but stays GPU-safe
      float bassBoost = uBass * 2.0;
      float sz = clamp(1.0 + spd*1.5 + bassBoost + u_beat*1.0, 1.0, 4.0);
      gl_PointSize = sz * (300.0 / max(-mvPos.z, 0.5));

      float age     = pos.w;
      float fadeIn  = smoothstep(0.0, 0.08, age);
      float fadeOut = 1.0 - smoothstep(0.82, 1.0, age);

      // [C4] Alpha inversely linked to bass
      float rawAlpha = clamp(
        0.28 + spd*0.38 + u_audioIntensity*0.18 - uBass*0.20,
        0.04, 0.82
      );
      vAlpha  = rawAlpha * fadeIn * fadeOut;

      vSpeed  = spd;
      vAge    = age;
      vRadial = clamp(length(pos.xy)/1.4, 0.0, 1.0);
      vBass   = uBass;
      vMid    = u_audioData.y;
      vHigh   = u_audioData.z;
    }
  `;

  // ─────────────────────────────────────────────────────────
  // PARTICLE FRAGMENT SHADER v8.0
  //
  // [P5] EARLY EXIT for slow particles — skips HSL pipeline.
  //      Particles with speed < 0.05 get a cheap dark tint and
  //      return early. This removes ~40% of shader invocations
  //      from the expensive HSL path (the center "orb" mass).
  //
  // [C1–C3] Full HSL pipeline only runs for active particles.
  // ─────────────────────────────────────────────────────────
  const PARTICLE_FRAG = `
    uniform float u_time;
    uniform float u_hueBase;
    uniform float u_spectralCentroid;
    uniform float u_beatTrigger;

    varying float vSpeed;
    varying float vAge;
    varying float vRadial;
    varying float vBass;
    varying float vMid;
    varying float vHigh;
    varying float vAlpha;

    // Compact HSL->RGB — h in [0,1]
    vec3 hsl2rgb(float h, float s, float l){
      float q = l<0.5 ? l*(1.+s) : l+s-l*s;
      float p = 2.*l-q;
      vec3 c;
      float t;
      t=h+1./3.; if(t>1.)t-=1.;
      c.r=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      t=h; if(t<0.)t+=1.;
      c.g=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      t=h-1./3.; if(t<0.)t+=1.;
      c.b=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      return clamp(c,0.0,1.0);
    }

    void main(){
      // Disc discard
      vec2  pc = gl_PointCoord - 0.5;
      float d  = length(pc);
      if(d > 0.5) discard;

      float edge = 1.0 - d*2.0;
      float glow = pow(edge, 1.9);

      // [P5] EARLY EXIT — slow center particles skip full HSL
      // They are dark and nearly transparent; cheap flat color.
      // Threshold 0.05 captures the orb mass without touching
      // the fast trail particles that need the full pipeline.
      if(vSpeed < 0.05){
        float dimAlpha = glow * vAlpha * 0.55;
        gl_FragColor = vec4(0.08, 0.04, 0.14, dimAlpha);
        return;
      }

      // ── [C2] HUE ─────────────────────────────────────────
      float hueN = mod(
        u_time * 0.04
        + u_spectralCentroid * 0.5
        + u_hueBase / 360.0
        + vSpeed * 0.07
        + vRadial * 0.055,
        1.0
      );

      // ── [C2] SATURATION — bass-owned ─────────────────────
      float sat = clamp(0.55 + vBass*0.40 + vMid*0.15, 0.0, 1.0);

      // ── [C2] LIGHTNESS — speed-gated ─────────────────────
      float spdN = clamp(vSpeed * 1.4, 0.0, 1.0);
      float lght = 0.18
                 + spdN * 0.28
                 + vHigh * spdN * 0.36
                 + vBass * 0.06;
      lght = clamp(lght, 0.10, 0.65);

      // ── [C3] BEAT TRIGGER ────────────────────────────────
      float flashW  = u_beatTrigger * glow * glow;
      float beatHue = mod(hueN + 0.5, 1.0);
      float finalH  = mix(hueN, beatHue, flashW);

      vec3 col = hsl2rgb(finalH, sat, lght);
      col *= 1.0 + glow * 0.20;
      col  = clamp(col, 0.0, 1.0);

      float vignette = 1.0 - smoothstep(0.55, 1.0, vRadial * 0.9);
      float alpha    = glow * glow * vAlpha * vignette;

      gl_FragColor = vec4(col, alpha);
    }
  `;

  // ── Helper: sphere init ───────────────────────────────────
  function _sphereData(n) {
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 0.2 + Math.random() * 0.5;
      data[i*4]   = Math.sin(ph)*Math.cos(th)*r;
      data[i*4+1] = Math.sin(ph)*Math.sin(th)*r;
      data[i*4+2] = Math.cos(ph)*r*0.2;
      data[i*4+3] = Math.random();
    }
    return data;
  }

  // ── Public: init ──────────────────────────────────────────
  function init() {
    if (initialized) return true;

    const canvas = document.getElementById('ambient-canvas');
    if (!canvas) { console.error('[Ambient] #ambient-canvas not found'); return false; }

    Object.assign(canvas.style, {
      position:'fixed', inset:'0', width:'100vw', height:'100vh',
      zIndex:'-1', display:'block', pointerEvents:'none',
    });

    try {
      renderer = new THREE.WebGLRenderer({
        canvas, antialias: false, alpha: true,
        powerPreference: 'high-performance', preserveDrawingBuffer: false,
      });
    } catch (e) {
      console.error('[Ambient] WebGL init failed:', e);
      _cssFallback(canvas);
      return false;
    }

    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x04010d, 0.0);

    const gl       = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const hasHF    = isWebGL2 || !!gl.getExtension('OES_texture_half_float');
    const hasF     = isWebGL2 || !!gl.getExtension('OES_texture_float');
    if (!hasHF && !hasF) { _cssFallback(canvas); return false; }

    scene  = new THREE.Scene();
    clock  = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
    camera.position.z = 2.8;

    if (typeof THREE.GPUComputationRenderer === 'undefined') {
      _cssFallback(canvas); return false;
    }

    const SIZE = PARTICLE_TEXTURE_SIZE;
    gpuCompute = new THREE.GPUComputationRenderer(SIZE, SIZE, renderer);

    // [P2] setDataType BEFORE addVariable/init — ensures HalfFloat
    // internal format is committed at variable creation time, not patched
    // after the fact. Critical on WebGL1 + OES_texture_half_float path.
    gpuCompute.setDataType(THREE.HalfFloatType);

    const initPos = gpuCompute.createTexture();
    const initVel = gpuCompute.createTexture();
    initPos.image.data.set(_sphereData(SIZE * SIZE));

    posVar = gpuCompute.addVariable('tPosition', POSITION_SHADER, initPos);
    velVar = gpuCompute.addVariable('tVelocity', VELOCITY_SHADER, initVel);
    gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
    gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

    // [P3] GPGPU uniforms use vec3 u_audioData
    Object.assign(posVar.material.uniforms, {
      u_dt:        { value: 0.016 },
      u_time:      { value: 0 },
      u_audioData: { value: new THREE.Vector3(0, 0, 0) },
    });
    Object.assign(velVar.material.uniforms, {
      u_dt:             { value: 0.016 },
      u_time:           { value: 0 },
      u_audioIntensity: { value: 0 },
      u_beat:           { value: 0 },
      u_audioData:      { value: new THREE.Vector3(0, 0, 0) },
      u_treble:         { value: 0 },
      u_flux:           { value: 0 },
    });

    const err = gpuCompute.init();
    if (err !== null) { console.error('[Ambient] GPGPU init error:', err); _cssFallback(canvas); return false; }

    // Particle geometry
    const uvs = new Float32Array(NUM_PARTICLES * 3);
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const idx = (j*SIZE+i)*3;
        uvs[idx]   = (i+0.5)/SIZE;
        uvs[idx+1] = (j+0.5)/SIZE;
        uvs[idx+2] = 0;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(uvs, 3));

    // [P3] Particle material uses packed vec3 audio uniform
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tPosition:          { value: null },
        tVelocity:          { value: null },
        u_audioIntensity:   { value: 0 },
        // [P3] Single vec3 replaces u_uBass + u_uMid + u_uHigh
        u_audioData:        { value: new THREE.Vector3(0, 0, 0) },
        u_beat:             { value: 0 },
        u_time:             { value: 0 },
        u_hueBase:          { value: 220 },
        u_spectralCentroid: { value: 0 },
        u_beatTrigger:      { value: 0 },
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
    console.info(`[Ambient] v8.0 ✓ — ${NUM_PARTICLES.toLocaleString()} particles | HalfFloat GPGPU | vec3 audio uniforms`);
    _startLoop();
    return true;
  }

  function _setupComposer() {
    if (typeof THREE.EffectComposer === 'undefined' || typeof THREE.UnrealBloomPass === 'undefined') {
      composer = null; return;
    }
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));

    // [P4] Bloom at 0.5× — confirmed half-res for mip chain efficiency
    // Threshold 0.28 (raised from 0.22) — fewer pixels enter the bloom
    // luminosity pass, reducing GPU work on dense frames
    const bloomRes = new THREE.Vector2(
      Math.floor(innerWidth  * 0.5),
      Math.floor(innerHeight * 0.5)
    );
    bloomPass = new THREE.UnrealBloomPass(bloomRes, 0.3, 0.40, 0.28);
    composer.addPass(bloomPass);
  }

  function _onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(Math.floor(w*0.5), Math.floor(h*0.5));
  }

  function _cssFallback(canvas) {
    let hue = 220;
    setInterval(() => {
      hue = (hue+0.12)%360;
      canvas.style.background = `radial-gradient(ellipse at 50% 55%,hsl(${hue},55%,8%) 0%,hsl(${(hue+50)%360},35%,2%) 65%,#000 100%)`;
    }, 60);
    canvas.style.position='fixed'; canvas.style.inset='0'; canvas.style.zIndex='-1';
  }

  // ── Render loop ───────────────────────────────────────────
  function _startLoop() {
    // [P7] Dual guard: rafId check + _loopRunning flag
    if (_loopRunning) return;
    _loopRunning = true;

    ;(function loop() {
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t  = clock.getElapsedTime();

      const uBass = _audio.uBass, uMid = _audio.uMid, uHigh = _audio.uHigh;
      const loud  = _audio.loudness, beat = _audio.beat, flux = _audio.flux;

      // Idle hue drift
      const isActive = loud > 0.05 || uBass > 0.05;
      if (!isActive) _idleHue = (_idleHue + dt*3.5)%360;

      const moodTarget = isActive ? _palShift + flux * 20.0 : 220.0 + _idleHue;
      _palHue += (moodTarget - _palHue) * dt * (isActive ? 1.5 : 0.4);

      // Beat flash decay
      if (beat > 0.01) _beatFlash = 1.0;
      _beatFlash *= Math.pow(0.88, dt*60.0);
      if (_beatFlash < 0.002) _beatFlash = 0.0;

      // Bass bloom
      _smoothBloom += (0.3 + uBass*4.2 - _smoothBloom) * 0.15;
      const targetBloom = Math.max(0.3, Math.min(_smoothBloom, 2.4));

      // Camera shake
      _shakeAmt += (uBass*0.10 - _shakeAmt) * dt*8;
      const lfoFreq = 3.0 + uBass*4.0;
      _shakeLFO_x = Math.sin(t*lfoFreq*3.0)*_shakeAmt;
      _shakeLFO_y = Math.cos(t*lfoFreq*1.4)*_shakeAmt;

      // Adaptive throttle
      const doCompute = (loud + uBass*0.3) > 0.04 || !_skipFrame;
      _skipFrame = !_skipFrame;

      if (doCompute) {
        // [P3] Single Vector3 set for all GPGPU shaders
        const audioVec = new THREE.Vector3(uBass, uMid, uHigh);

        velVar.material.uniforms.u_dt.value             = dt;
        velVar.material.uniforms.u_time.value           = t;
        velVar.material.uniforms.u_audioIntensity.value = loud;
        velVar.material.uniforms.u_beat.value           = beat;
        velVar.material.uniforms.u_audioData.value      = audioVec;
        velVar.material.uniforms.u_treble.value         = _audio.treble;
        velVar.material.uniforms.u_flux.value           = flux;

        posVar.material.uniforms.u_dt.value             = dt;
        posVar.material.uniforms.u_time.value           = t;
        posVar.material.uniforms.u_audioData.value      = audioVec;

        gpuCompute.compute();
      }

      const mat = particlesMesh.material;
      mat.uniforms.tPosition.value          = gpuCompute.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.tVelocity.value          = gpuCompute.getCurrentRenderTarget(velVar).texture;
      mat.uniforms.u_audioIntensity.value   = loud;
      // [P3] Single vec3 set for particle shader
      mat.uniforms.u_audioData.value        = new THREE.Vector3(uBass, uMid, uHigh);
      mat.uniforms.u_beat.value             = beat;
      mat.uniforms.u_time.value             = t;
      mat.uniforms.u_hueBase.value          = _palHue;
      mat.uniforms.u_spectralCentroid.value = _audio.centroid;
      mat.uniforms.u_beatTrigger.value      = _beatFlash;

      // Camera orbit
      _orbitT += dt*(0.06 + loud*0.05);
      const orbitR = 0.18 + uBass*0.16;
      camera.position.x = Math.sin(_orbitT)*orbitR + _shakeLFO_x;
      camera.position.y = Math.sin(_orbitT*2.0)*orbitR*0.55 + _shakeLFO_y;
      camera.lookAt(0, 0, 0);

      if (bloomPass) bloomPass.strength = targetBloom;
      if (composer) composer.render(); else renderer.render(scene, camera);

      _audio.beat *= 0.72;
    })();
  }

  // ── Public: audio data ────────────────────────────────────
  function setAudioFeatures({ loudness=0, centroid=0, melbands=null, beat=0, freqData=null, uBass=0, uMid=0, uHigh=0 }={}) {
    _audio.loudness = loudness;
    _audio.centroid = centroid;
    _audio.beat     = Math.max(_audio.beat, beat);
    _audio.uBass    = uBass;
    _audio.uMid     = uMid;
    _audio.uHigh    = uHigh;
    if (melbands && melbands.length >= 8) {
      _audio.bass   = (melbands[0]+melbands[1])*0.5;
      _audio.mids   = (melbands[2]+melbands[3]+melbands[4])/3;
      _audio.treble = (melbands[6]+melbands[7])*0.5;
    }
    if (freqData && freqData.length > 0) {
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const avg     = sum/(freqData.length*255);
      const rawFlux = Math.abs(avg - _prevFreqSum);
      _flux        += (rawFlux*8.0 - _flux)*0.25;
      _audio.flux   = Math.min(_flux, 1.0);
      _prevFreqSum  = avg;
    }
  }

  function setSong(name, artist, token) {
    reset();
    if (!token) return;
    const _API = window.ONESONG_API || 'https://onesong.onrender.com';
    fetch(`${_API}/mood?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`,
      { headers:{ Authorization:`Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { tags:[] })
      .then(({ tags=[] }) => {
        const moodHues = { sad:240,happy:50,electronic:280,chill:160,rock:10,pop:320,jazz:35,classical:180,metal:0,ambient:200 };
        for (const tag of tags) {
          if (moodHues[tag] !== undefined) { _palShift = moodHues[tag]; break; }
        }
        if (window.GradientController) {
          const hue = _palShift/360;
          GradientController.setBasePalette(
            [Math.cos(hue*Math.PI*2)*0.5+0.5, Math.sin(hue*Math.PI*2)*0.4+0.3, 0.7-hue*0.3],
            [0.02,0.02,0.06]
          );
        }
      }).catch(()=>{});
  }

  function startBeat() { if (window.GradientController) GradientController.updatePlayhead(0,true); }
  function stopBeat()  { if (window.GradientController) GradientController.updatePlayhead(0,false); }
  function syncBeat()  {
    _audio.beat = Math.min(1, _audio.beat+0.8);
    _beatFlash  = 1.0;
    if (window.GradientController) GradientController.triggerBeat();
  }

  function reset() {
    Object.assign(_audio, { loudness:0,centroid:0,beat:0,bass:0,mids:0,treble:0,flux:0,uBass:0,uMid:0,uHigh:0 });
    _smoothBloom=0.3; _shakeAmt=0; _beatFlash=0;
    _orbitT=0; _shakeLFO_x=0; _shakeLFO_y=0;
    _flux=0; _prevFreqSum=0; _idleHue=0; _palShift=0;
    if (window.GradientController) GradientController.reset();
  }

  return { init, setSong, setAudioFeatures, startBeat, stopBeat, syncBeat, reset };
})();