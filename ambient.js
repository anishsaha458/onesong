/**
 * ambient.js — GPGPU Flow Field Visualizer  v7.0
 * ─────────────────────────────────────────────────────────────
 * PROBLEM SOLVED: "White Orb" Effect
 *
 * Root cause in v6.0: HSL→RGB ran in the VERTEX shader, producing
 * a vColor varying. The FRAGMENT shader then applied:
 *   gl_FragColor = vec4(vColor * (1.0 + glow * 0.5), ...)
 * This multiplied already-bright colors by up to 1.5. With
 * AdditiveBlending and 65k particles stacking in the center,
 * every pixel saturated to pure white regardless of audio.
 *
 * ═══════════════════════════════════════════════════════════
 * NEW IN v7.0
 * ═══════════════════════════════════════════════════════════
 *
 * [C1] FRAGMENT SHADER — FULL HSL COLOR PIPELINE
 *      All color computation moved INTO the fragment shader where
 *      gl_PointCoord is available. Vertex shader now only passes
 *      raw physics data as varyings (speed, age, radial, band values).
 *      No color math in the vertex shader at all.
 *
 * [C2] HSL MAPPING — PER FREQUENCY BAND OWNERSHIP
 *      HUE:        u_hueBase (JS) + vSpeed * 0.08 + vRadial * 0.06
 *                  u_hueBase = centroid * 180 + moodShift + idleDrift
 *                  Spectral centroid maps bass-heavy → warm (reds/oranges)
 *                  and treble-heavy → cool (cyans/blues) across 180°.
 *
 *      SATURATION: 0.55 + uBass * 0.40 + uMid * 0.15
 *                  Bass kicks saturate colors. Base 0.55 ensures
 *                  colors always exist even at silence.
 *
 *      LIGHTNESS:  SPEED-GATED. Only fast particles get brightened by uHigh.
 *                  0.18 + spdNorm*0.28 + uHigh*spdNorm*0.38 + uBass*0.06
 *                  Hard cap at 0.65. This is the critical white-orb fix:
 *                  slow center particles stay dark/saturated; only the
 *                  fast edge particles blow toward white on cymbal hits.
 *
 * [C3] BEAT TRIGGER — COMPLEMENTARY HUE LERP WITH TRAIL
 *      JS: _beatFlash set to 1.0 on detection, decays α=0.88/frame (~400ms).
 *      Uniform name: u_beatTrigger (per spec).
 *      GLSL: hue = mix(ambient, ambient+0.5, u_beatTrigger*glow²)
 *      Center of each particle flashes complementary color; edges stay
 *      ambient. As flash decays the color trails back — this is the
 *      "trail" from beat color back to ambient color.
 *
 * [C4] OPACITY ARCHITECTURE — INVERSE SIZE/ALPHA LINK
 *      Large bass-driven particles → more transparent.
 *      Small fast particles → more opaque.
 *      Base alpha 0.28 − uBass * 0.18. This prevents the center
 *      from stacking to white on kicks. Bass particles spread over
 *      a large area with low alpha; fast trail particles are small
 *      and dense with full alpha.
 *
 * [C5] DARK BACKGROUND — deep purple-black clear color (not pure black)
 *      Particles near screen edges fade into color not void.
 *
 * [S1-S4] ALL v6.0 PHYSICS RETAINED:
 *      [S1] Bass explosion  [S2] Mid freq modulation
 *      [S3] High white noise  [S4] Viscosity damping
 *      [S5] Bass bloom pulse  [V1-V10] All v5.0 improvements
 */

const Ambient = (() => {

  const PARTICLE_TEXTURE_SIZE = 256;
  const NUM_PARTICLES = PARTICLE_TEXTURE_SIZE * PARTICLE_TEXTURE_SIZE;

  let renderer, scene, camera, clock;
  let gpuCompute, posVar, velVar;
  let particlesMesh;
  let composer, bloomPass;
  let initialized = false;
  let rafId = null;

  // Camera [V3, V10]
  let _orbitT = 0, _shakeLFO_x = 0, _shakeLFO_y = 0, _shakeAmt = 0;

  // [S5] Bloom
  let _smoothBloom = 0.3;

  // [C3] Beat flash decay
  let _beatFlash = 0.0;

  // [V9] Throttle
  let _skipFrame = false;

  // Palette [V7]
  let _palHue = 220, _palShift = 0, _idleHue = 0;

  // [V5] Flux
  let _prevFreqSum = 0, _flux = 0;

  const _audio = {
    loudness: 0, centroid: 0, beat: 0,
    bass: 0, mids: 0, treble: 0, flux: 0,
    uBass: 0, uMid: 0, uHigh: 0,
  };

  // ─────────────────────────────────────────────────────────
  // GLSL: Simplex Noise + Curl (unchanged from v6)
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
  // VELOCITY SHADER — physics identical to v6.0
  // [S1] Bass explosion  [S2] Mid freq mod  [S3] High noise
  // ─────────────────────────────────────────────────────────
  const VELOCITY_SHADER = `
    ${GLSL_NOISE}
    uniform float u_time, u_dt, u_audioIntensity, u_beat;
    uniform float u_uBass, u_uMid, u_uHigh, u_treble, u_flux;

    vec3 hash3(vec3 p){
      p=fract(p*vec3(443.897,441.423,437.195));
      p+=dot(p,p.yxz+19.19);
      return fract((p.xxy+p.yxx)*p.zyx)*2.0-1.0;
    }

    void main(){
      vec2 uv  = gl_FragCoord.xy/resolution.xy;
      vec4 pos = texture2D(tPosition,uv);
      vec4 vel = texture2D(tVelocity,uv);

      float scale1    = 0.55 + u_uMid*1.30;
      float scale2    = scale1*2.3 + u_uMid*1.20;
      float intensity = 0.18 + u_audioIntensity*1.2;

      vec3 p3    = vec3(pos.xy, pos.z + u_time*0.08);
      vec3 curl1 = curlNoise(p3, scale1, intensity);
      vec3 p3b   = vec3(pos.xy*1.1+vec2(17.3,31.7), pos.z-u_time*0.05+5.4);
      vec3 curl2 = curlNoise(p3b, scale2, intensity*0.38);
      vec3 curl  = mix(curl1, curl1+curl2, 0.25+u_uMid*0.45);

      vel.xyz += (curl - vel.xyz)*u_dt*3.5;

      // [S1] Bass explosion
      float r   = length(pos.xyz);
      float bSq = u_uBass*u_uBass;
      vel.xyz += normalize(pos.xyz+0.0001)*bSq*8.0*exp(-r*1.2)*u_dt*60.0;

      // Beat radial burst
      vel.xy += normalize(pos.xy+0.0001)*u_beat*3.0*exp(-length(pos.xy)*1.8)*u_dt*60.0;

      // [S3] High white-noise jitter
      vec3 jitter = hash3(pos.xyz*847.3+vec3(u_time*31.7,u_time*17.3,u_time*43.1));
      vel.xyz += jitter*(u_uHigh*u_uHigh*2.8)*u_dt*60.0;

      // Legacy treble coherent jitter
      vel.xy += vec2(snoise(p3*4.2+vec3(u_time*0.3,0.,0.)),snoise(p3*4.2+vec3(0.,u_time*0.3,0.)))*u_treble*0.15;

      // Soft boundary
      vel.xyz -= normalize(pos.xyz)*smoothstep(1.3,1.7,r)*0.6*u_dt*60.0;

      gl_FragColor = vec4(vel.xyz, length(curl1));
    }
  `;

  // ─────────────────────────────────────────────────────────
  // POSITION SHADER — [S4] Viscosity damping
  // ─────────────────────────────────────────────────────────
  const POSITION_SHADER = `
    uniform float u_dt, u_time, u_uBass;

    void main(){
      vec2 uv  = gl_FragCoord.xy/resolution.xy;
      vec4 pos = texture2D(tPosition,uv);
      vec4 vel = texture2D(tVelocity,uv);

      // [S4] honey(0.880) ↔ water(0.994) based on raw bass
      float damping = mix(0.880, 0.994, clamp(u_uBass*3.0,0.0,1.0));
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
        rr=mix(rr,rr*1.4,u_uBass*0.5);
        pos.xyz=vec3(sin(ph)*cos(th)*rr,sin(ph)*sin(th)*rr,cos(ph)*rr*0.4);
        age=0.0;
      }
      pos.w=age;
      gl_FragColor=pos;
    }
  `;

  // ─────────────────────────────────────────────────────────
  // PARTICLE VERTEX SHADER v7.0
  //
  // [C4] Size/alpha inverse link — bass grows size, reduces alpha.
  //      Vertex shader passes ONLY physics data to fragment.
  //      Zero color math here.
  // ─────────────────────────────────────────────────────────
  const PARTICLE_VERT = `
    uniform sampler2D tPosition;
    uniform sampler2D tVelocity;
    uniform float u_audioIntensity;
    uniform float u_uBass, u_uMid, u_uHigh, u_beat, u_time;

    // [C1] Physics varyings — fragment shader computes color from these
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

      float spd = length(vel.xyz);

      // [C4] INVERSE SIZE/ALPHA LINK
      // Bass particles: larger disc, lower alpha → can't stack to white
      // Fast particles: smaller disc, higher alpha → vivid color
      float bassBoost = u_uBass * 4.5;
      float sz = max(0.5, 1.1 + spd*2.0 + bassBoost + u_beat*2.0);
      gl_PointSize = sz * (300.0 / max(-mvPos.z, 0.5));

      // Lifetime fade [V2]
      float age     = pos.w;
      float fadeIn  = smoothstep(0.0, 0.08, age);
      float fadeOut = 1.0 - smoothstep(0.82, 1.0, age);

      // [C4] Alpha inversely linked to bass (larger = more transparent)
      // Base 0.28, heavily reduced when bass is driving large particles
      float rawAlpha = clamp(
        0.28 + spd*0.38 + u_audioIntensity*0.18 - u_uBass*0.20,
        0.04, 0.82
      );
      vAlpha  = rawAlpha * fadeIn * fadeOut;

      // Pass physics data to fragment
      vSpeed  = spd;
      vAge    = age;
      vRadial = clamp(length(pos.xy)/1.4, 0.0, 1.0);
      vBass   = u_uBass;
      vMid    = u_uMid;
      vHigh   = u_uHigh;
    }
  `;

  // ─────────────────────────────────────────────────────────
  // PARTICLE FRAGMENT SHADER v7.0
  //
  // [C1] ENTIRE HSL pipeline lives here — has gl_PointCoord.
  // [C2] Hue/Sat/Light each owned by exactly one frequency band.
  // [C3] Beat flash: complementary hue lerp, center-weighted, decays.
  // ─────────────────────────────────────────────────────────
  const PARTICLE_FRAG = `
    uniform float u_time;
    uniform float u_hueBase;          // JS: moodShift + idleDrift base offset [0,360]
    uniform float u_spectralCentroid; // [C2] 0→1, maps bass-heavy→warm, treble→cool
    uniform float u_beatTrigger;      // [C3] renamed per spec: 1.0 on beat, decays ~400ms

    varying float vSpeed;
    varying float vAge;
    varying float vRadial;
    varying float vBass;
    varying float vMid;
    varying float vHigh;
    varying float vAlpha;

    // Compact HSL->RGB — input h in [0,1]
    vec3 hsl2rgb(float h, float s, float l){
      float q = l<0.5 ? l*(1.+s) : l+s-l*s;
      float p = 2.*l-q;
      vec3 c;
      float t;
      // R
      t=h+1./3.; if(t>1.)t-=1.;
      c.r=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      // G
      t=h; if(t<0.)t+=1.;
      c.g=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      // B
      t=h-1./3.; if(t<0.)t+=1.;
      c.b=t<1./6.?p+(q-p)*6.*t:t<.5?q:t<2./3.?p+(q-p)*(2./3.-t)*6.:p;
      return clamp(c,0.0,1.0);
    }

    void main(){
      // Disc shape — discard outside circle
      vec2  pc = gl_PointCoord - 0.5;
      float d  = length(pc);
      if(d > 0.5) discard;

      // Center weight — 1 at center, 0 at rim
      float edge = 1.0 - d*2.0;
      float glow = pow(edge, 1.9);  // concentrated center

      // ── [C2] HUE ─────────────────────────────────────────
      // Formula per spec: u_time * drift_rate + u_spectralCentroid * 0.5
      // u_time * 0.04: slow 14.4°/s continuous drift — keeps field alive at rest.
      // u_spectralCentroid * 0.5: maps [0,1] centroid to a [0,0.5] hue offset.
      //   centroid≈0 (bass-heavy) → warm end (reds, oranges).
      //   centroid≈1 (treble-heavy) → cool end (cyans, blue-greens).
      // u_hueBase / 360.0: mood + idle drift offset from JS.
      // Per-particle: speed tints hue, radial position shifts toward edge hue.
      float hueN = mod(
        u_time * 0.04
        + u_spectralCentroid * 0.5
        + u_hueBase / 360.0
        + vSpeed * 0.07
        + vRadial * 0.055,
        1.0
      );

      // ── [C2] SATURATION — bass-owned ─────────────────────
      // Base 0.55 ensures color at all times (never grey).
      // Bass adds up to 0.40 on a hard kick.
      // Mids add smaller richness boost.
      float sat = clamp(0.55 + vBass*0.40 + vMid*0.15, 0.0, 1.0);

      // ── [C2] LIGHTNESS — speed-gated, high-frequency owned ─
      // THE KEY FIX: lightness is gated by normalized speed.
      // Slow particles (center mass) stay dark → no white orb.
      // Only the fastest particles (edges, post-explosion) get
      // brightened by uHigh. Hard cap 0.65 prevents blowout.
      float spdN = clamp(vSpeed * 1.4, 0.0, 1.0);
      float lght = 0.18
                 + spdN * 0.28              // speed earns brightness
                 + vHigh * spdN * 0.36      // highs only boost fast particles
                 + vBass * 0.06;            // kick adds faint warmth
      lght = clamp(lght, 0.10, 0.65);      // hard cap — prevents blowout

      // ── [C3] BEAT TRIGGER — complementary hue lerp + trail ──
      // u_beatTrigger decays 1→0 over ~400ms (JS side).
      // Flash is strongest at particle CENTER (glow²), creating a
      // radial pop of complementary color. As it decays the color
      // trails from the beat hue back to ambient — the "trail" effect.
      // Complementary hue = ambient hue rotated 180° (+ 0.5 in [0,1]).
      float flashW  = u_beatTrigger * glow * glow;
      float beatHue = mod(hueN + 0.5, 1.0);
      float finalH  = mix(hueN, beatHue, flashW);

      // Compute RGB
      vec3 col = hsl2rgb(finalH, sat, lght);

      // Modest glow multiplier — max 1.20 (was 1.5 in v6, caused blowout)
      col *= 1.0 + glow * 0.20;
      col  = clamp(col, 0.0, 1.0);

      // ── VIGNETTE — subtle screen-edge darkening ───────────
      // gl_FragCoord is in window pixels; convert to NDC [-1,1].
      // Vignette darkens the disc alpha near screen edges, pushing
      // the visual weight toward the center and creating depth.
      // Uses a smooth falloff so it's barely noticeable until
      // particles reach the outer 30% of the screen.
      // Note: gl_FragCoord not reliable per-particle position for
      // screen vignette — apply via alpha modulation from vRadial
      // which encodes 3D distance from origin (good proxy for screen center).
      float vignette = 1.0 - smoothstep(0.55, 1.0, vRadial * 0.9);

      // Alpha: glow² makes center opaque, edge transparent; vignette darkens edges
      float alpha = glow * glow * vAlpha * vignette;

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
    // [C5] Deep purple-black — not pure black. Particles at edges
    // fade into color rather than void.
    renderer.setClearColor(0x04010d, 0.0);

    const gl        = renderer.getContext();
    const isWebGL2  = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const hasHF     = isWebGL2 || !!gl.getExtension('OES_texture_half_float');
    const hasF      = isWebGL2 || !!gl.getExtension('OES_texture_float');
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
    gpuCompute.setDataType(THREE.HalfFloatType);

    const initPos = gpuCompute.createTexture();
    const initVel = gpuCompute.createTexture();
    initPos.image.data.set(_sphereData(SIZE * SIZE));

    posVar = gpuCompute.addVariable('tPosition', POSITION_SHADER, initPos);
    velVar = gpuCompute.addVariable('tVelocity', VELOCITY_SHADER, initVel);
    gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
    gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);

    Object.assign(posVar.material.uniforms, {
      u_dt:    { value: 0.016 },
      u_time:  { value: 0 },
      u_uBass: { value: 0 },
    });
    Object.assign(velVar.material.uniforms, {
      u_dt:             { value: 0.016 },
      u_time:           { value: 0 },
      u_audioIntensity: { value: 0 },
      u_beat:           { value: 0 },
      u_uBass:          { value: 0 },
      u_uMid:           { value: 0 },
      u_uHigh:          { value: 0 },
      u_treble:         { value: 0 },
      u_flux:           { value: 0 },
    });

    const err = gpuCompute.init();
    if (err !== null) { console.error('[Ambient] GPGPU init error:', err); _cssFallback(canvas); return false; }

    // Particle geometry — UV coords into GPGPU textures
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

    // [C1] Fragment shader owns all color — minimal vertex uniforms
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tPosition:          { value: null },
        tVelocity:          { value: null },
        u_audioIntensity:   { value: 0 },
        u_uBass:            { value: 0 },
        u_uMid:             { value: 0 },
        u_uHigh:            { value: 0 },
        u_beat:             { value: 0 },
        u_time:             { value: 0 },
        // Fragment-only color uniforms
        u_hueBase:           { value: 220 },
        u_spectralCentroid:  { value: 0 },   // [C2] direct centroid → GLSL hue formula
        u_beatTrigger:       { value: 0 },   // [C3] renamed per spec; decays 1→0 ~400ms
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
    console.info(`[Ambient] v7.0 ✓ — ${NUM_PARTICLES.toLocaleString()} particles`);
    _startLoop();
    return true;
  }

  function _setupComposer() {
    if (typeof THREE.EffectComposer === 'undefined' || typeof THREE.UnrealBloomPass === 'undefined') {
      composer = null; return;
    }
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const bloomRes = new THREE.Vector2(Math.floor(innerWidth*0.5), Math.floor(innerHeight*0.5));
    // Threshold 0.22: only fast/bright particle centers trigger bloom
    bloomPass = new THREE.UnrealBloomPass(bloomRes, 0.3, 0.40, 0.22);
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
    if (rafId !== null) return;
    ;(function loop() {
      rafId = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t  = clock.getElapsedTime();

      const uBass = _audio.uBass, uMid = _audio.uMid, uHigh = _audio.uHigh;
      const loud  = _audio.loudness, beat = _audio.beat, flux = _audio.flux;

  // [V7] Idle hue drift — centroid is now passed directly to GLSL as u_spectralCentroid.
      // u_hueBase carries only mood shift + idle drift (not centroid).
      // This matches the spec: HUE = u_time*drift + u_spectralCentroid*0.5 in GLSL.
      const isActive = loud > 0.05 || uBass > 0.05;
      if (!isActive) _idleHue = (_idleHue + dt*3.5)%360;

      // u_hueBase = mood shift + idle drift only (centroid handled in GLSL directly)
      const moodTarget = isActive ? _palShift + flux * 20.0 : 220.0 + _idleHue;
      _palHue += (moodTarget - _palHue) * dt * (isActive ? 1.5 : 0.4);

      // [C3] Beat flash — JS-side decay, feeds fragment shader
      if (beat > 0.01) _beatFlash = 1.0;
      _beatFlash *= Math.pow(0.88, dt*60.0);
      if (_beatFlash < 0.002) _beatFlash = 0.0;

      // [S5] Bass bloom — α=0.15, range 0.3→2.4
      _smoothBloom += (0.3 + uBass*4.2 - _smoothBloom) * 0.15;
      const targetBloom = Math.max(0.3, Math.min(_smoothBloom, 2.4));

      // Camera shake [V10]
      _shakeAmt += (uBass*0.10 - _shakeAmt) * dt*8;
      const lfoFreq = 3.0 + uBass*4.0;
      _shakeLFO_x = Math.sin(t*lfoFreq*3.0)*_shakeAmt;
      _shakeLFO_y = Math.cos(t*lfoFreq*1.4)*_shakeAmt;

      // [V9] Adaptive throttle
      const doCompute = (loud + uBass*0.3) > 0.04 || !_skipFrame;
      _skipFrame = !_skipFrame;

      if (doCompute) {
        velVar.material.uniforms.u_dt.value             = dt;
        velVar.material.uniforms.u_time.value           = t;
        velVar.material.uniforms.u_audioIntensity.value = loud;
        velVar.material.uniforms.u_beat.value           = beat;
        velVar.material.uniforms.u_uBass.value          = uBass;
        velVar.material.uniforms.u_uMid.value           = uMid;
        velVar.material.uniforms.u_uHigh.value          = uHigh;
        velVar.material.uniforms.u_treble.value         = _audio.treble;
        velVar.material.uniforms.u_flux.value           = flux;
        posVar.material.uniforms.u_dt.value             = dt;
        posVar.material.uniforms.u_time.value           = t;
        posVar.material.uniforms.u_uBass.value          = uBass;
        gpuCompute.compute();
      }

      const mat = particlesMesh.material;
      mat.uniforms.tPosition.value        = gpuCompute.getCurrentRenderTarget(posVar).texture;
      mat.uniforms.tVelocity.value        = gpuCompute.getCurrentRenderTarget(velVar).texture;
      mat.uniforms.u_audioIntensity.value = loud;
      mat.uniforms.u_uBass.value          = uBass;
      mat.uniforms.u_uMid.value           = uMid;
      mat.uniforms.u_uHigh.value          = uHigh;
      mat.uniforms.u_beat.value           = beat;
      mat.uniforms.u_time.value           = t;
      mat.uniforms.u_hueBase.value           = _palHue;    // [C2] mood + idle drift
      mat.uniforms.u_spectralCentroid.value  = _audio.centroid; // [C2] direct to GLSL
      mat.uniforms.u_beatTrigger.value       = _beatFlash; // [C3] spec name

      // [V3] Camera orbit
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