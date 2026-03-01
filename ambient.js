/**
 * ambient.js — GPGPU Flow Field Visualizer
 * Three.js FBO Particle System · 100k particles · Curl Noise Physics
 * Audio-synced via GradientController and AudioAnalytics timeline
 */

const Ambient = (() => {

  // ── Config ───────────────────────────────────────────────────
  const PARTICLE_COUNT = 131072; // 512×256 = 2^17, perfect for FBO
  const FBO_WIDTH  = 512;
  const FBO_HEIGHT = 256;
  const TRAIL_DECAY = 0.965;

  // ── State ────────────────────────────────────────────────────
  let renderer, scene, camera;
  let simMaterial, particleMaterial, trailMaterial;
  let positionFBO, velocityFBO;          // ping-pong buffers
  let positionFBO2, velocityFBO2;
  let trailFBO, trailFBO2;               // persistence trail buffers
  let particleMesh, quadMesh, trailQuad;
  let clock;
  let initialized = false;

  // Beat state
  let beatPulse     = 0;
  let beatTimer     = null;
  let isPlaying     = false;
  let lastFrameTime = performance.now();

  // Audio features (smoothed)
  let uLoudness  = 0;
  let uCentroid  = 0;
  let uMelbands  = new Float32Array(8);
  let uBeat      = 0;

  // Palette
  let paletteTop    = new THREE.Color(0.2, 0.5, 0.9);
  let paletteBottom = new THREE.Color(0.05, 0.05, 0.12);
  let targetTop     = new THREE.Color(0.2, 0.5, 0.9);
  let targetBottom  = new THREE.Color(0.05, 0.05, 0.12);

  // ── GLSL Shaders ─────────────────────────────────────────────

  const SIMPLEX_GLSL = `
    // Classic 3D Simplex Noise by Stefan Gustavson
    vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
    vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
    vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}

    float snoise(vec3 v){
      const vec2 C=vec2(1./6.,1./3.);
      const vec4 D=vec4(0.,.5,1.,2.);
      vec3 i=floor(v+dot(v,C.yyy));
      vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz);
      vec3 l=1.-g;
      vec3 i1=min(g.xyz,l.zxy);
      vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx;
      vec3 x2=x0-i2+C.yyy;
      vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(
        i.z+vec4(0.,i1.z,i2.z,1.))+
        i.y+vec4(0.,i1.y,i2.y,1.))+
        i.x+vec4(0.,i1.x,i2.x,1.));
      float n_=.142857142857;
      vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z);
      vec4 y_=floor(j-7.*x_);
      vec4 x=x_*ns.x+ns.yyyy;
      vec4 y=y_*ns.x+ns.yyyy;
      vec4 h=1.-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy);
      vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.+1.;
      vec4 s1=floor(b1)*2.+1.;
      vec4 sh=-step(h,vec4(0.));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
      vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x);
      vec3 p1=vec3(a0.zw,h.y);
      vec3 p2=vec3(a1.xy,h.z);
      vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
      vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
      m=m*m;
      return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    // Curl noise — divergence-free 3D vector field
    vec3 curlNoise(vec3 p){
      const float e=1e-4;
      vec3 dx=vec3(e,0.,0.);
      vec3 dy=vec3(0.,e,0.);
      vec3 dz=vec3(0.,0.,e);
      float x=snoise(p+dy)-snoise(p-dy)-snoise(p+dz)+snoise(p-dz);
      float y=snoise(p+dz)-snoise(p-dz)-snoise(p+dx)+snoise(p-dx);
      float z=snoise(p+dx)-snoise(p-dx)-snoise(p+dy)+snoise(p-dy);
      return normalize(vec3(x,y,z))/(2.*e);
    }
  `;

  // Simulation shader — updates particle positions via curl noise
  const SIM_VERT = `
    varying vec2 vUv;
    void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
  `;

  const SIM_FRAG = `
    precision highp float;
    uniform sampler2D uPosition;
    uniform sampler2D uVelocity;
    uniform float uTime;
    uniform float uDeltaTime;
    uniform float uLoudness;
    uniform float uCentroid;
    uniform float uBeat;
    uniform float uMelBass;
    uniform float uMelMid;
    varying vec2 vUv;

    ${SIMPLEX_GLSL}

    void main(){
      vec3 pos = texture2D(uPosition, vUv).xyz;
      vec3 vel = texture2D(uVelocity, vUv).xyz;

      // Noise frequency driven by spectral centroid (brighter = more chaotic)
      float noiseFreq = 0.8 + uCentroid * 2.5;
      // Flow speed driven by loudness
      float flowSpeed = 0.3 + uLoudness * 1.8 + uMelBass * 0.8;

      vec3 noisePos = pos * noiseFreq + vec3(uTime * 0.12, uTime * 0.09, uTime * 0.07);
      vec3 curl = curlNoise(noisePos) * flowSpeed;

      // Beat shockwave — radial burst from origin
      float dist = length(pos);
      vec3 beatForce = normalize(pos + 0.001) * uBeat * 2.5 * exp(-dist * 1.5);

      // Bass mid warps vertical axis
      curl.y += uMelMid * snoise(pos * 1.5 + vec3(0., uTime * 0.2, 0.)) * 0.4;

      // Integrate velocity
      vec3 acc = (curl + beatForce - vel * 0.6);
      vel += acc * uDeltaTime * 3.0;
      vel *= 0.985; // drag

      // Boundary repulsion — keep in unit sphere
      if(dist > 1.2){
        vel += -normalize(pos) * (dist - 1.2) * 0.8;
      }

      pos += vel * uDeltaTime;

      // Respawn dead particles at random surface
      float rand = fract(sin(dot(vUv, vec2(127.1, 311.7))) * 43758.5);
      float rand2 = fract(sin(dot(vUv, vec2(269.5, 183.3))) * 43758.5);
      if(length(pos) > 1.6 || length(vel) < 0.0001){
        float theta = rand * 6.2832;
        float phi = acos(2. * rand2 - 1.);
        float r = 0.5 + rand * 0.3;
        pos = vec3(sin(phi)*cos(theta)*r, sin(phi)*sin(theta)*r, cos(phi)*r);
        vel = vec3(0.);
      }

      gl_FragColor = vec4(pos, 1.0);
    }
  `;

  // Velocity pass (separate for stability)
  const VEL_FRAG = SIM_FRAG; // combined in position pass for simplicity

  // Particle vertex shader — size from bass melband
  const PARTICLE_VERT = `
    uniform sampler2D uPosition;
    uniform float uMelBass;
    uniform float uLoudness;
    uniform float uBeat;
    uniform vec3 uColorTop;
    uniform vec3 uColorBottom;
    varying vec3 vColor;
    varying float vAlpha;

    void main(){
      // Each particle reads its own position from the FBO texture
      vec2 uv = position.xy; // position.xy stores the UV lookup
      vec3 pos = texture2D(uPosition, uv).xyz;

      // Project
      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mvPos;

      // Size from bass energy + beat pulse
      float bassPulse = uMelBass * 3.0 + uBeat * 2.0;
      gl_PointSize = (1.5 + bassPulse * 1.5) * (300.0 / -mvPos.z);

      // Color: lerp by vertical position and centroid
      float t = pos.y * 0.5 + 0.5;
      vColor = mix(uColorBottom, uColorTop, t);
      // Brightness boost on beat
      vColor += vec3(0.1) * uBeat;

      // Alpha from velocity magnitude (fast = brighter)
      vAlpha = clamp(0.4 + uLoudness * 0.6, 0.1, 1.0);
    }
  `;

  const PARTICLE_FRAG = `
    precision highp float;
    varying vec3 vColor;
    varying float vAlpha;

    void main(){
      // Soft circle with bloom-ready glow
      vec2 d = gl_PointCoord - 0.5;
      float dist = length(d);
      if(dist > 0.5) discard;

      // Distance-based alpha falloff
      float alpha = (1.0 - dist * 2.0);
      alpha = alpha * alpha * vAlpha;

      // Glow: brighter core
      vec3 col = vColor + vColor * (1.0 - dist * 2.0) * 0.8;

      gl_FragColor = vec4(col, alpha);
    }
  `;

  // Trail / persistence pass — accumulates frames for inky trails
  const TRAIL_VERT = `
    varying vec2 vUv;
    void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}
  `;

  const TRAIL_FRAG = `
    precision highp float;
    uniform sampler2D uParticles; // current frame
    uniform sampler2D uTrail;     // previous trail
    uniform float uDecay;
    varying vec2 vUv;

    void main(){
      vec4 current = texture2D(uParticles, vUv);
      vec4 prev    = texture2D(uTrail, vUv);
      // Feedback: decay old trail, add new particles
      vec4 trail = prev * uDecay + current;
      gl_FragColor = clamp(trail, 0., 1.);
    }
  `;

  // Final composite — tonemap and vignette
  const FINAL_FRAG = `
    precision highp float;
    uniform sampler2D uTrail;
    uniform vec2 uRes;
    uniform float uBrightness;
    varying vec2 vUv;

    void main(){
      vec4 col = texture2D(uTrail, vUv);

      // Filmic tonemapping
      vec3 c = col.rgb;
      c = c * (2.51 * c + 0.03) / (c * (2.43 * c + 0.59) + 0.14);

      // Vignette
      vec2 uv = vUv - 0.5;
      float vig = 1.0 - dot(uv, uv) * 1.8;
      c *= clamp(vig, 0., 1.);

      // Chromatic aberration hint on edges
      float aberr = length(uv) * 0.003;
      float rr = texture2D(uTrail, vUv + vec2(aberr, 0.)).r;
      float bb = texture2D(uTrail, vUv - vec2(aberr, 0.)).b;
      c.r = mix(c.r, rr, 0.3);
      c.b = mix(c.b, bb, 0.3);

      c *= uBrightness;
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.0);
    }
  `;

  // ── Internal helpers ─────────────────────────────────────────

  function createFBO(w, h, type = THREE.FloatType) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  function createParticleUVs() {
    // Each particle stores its own UV coords so it can sample the FBO
    const uvs = new Float32Array(PARTICLE_COUNT * 3);
    let i = 0;
    for (let y = 0; y < FBO_HEIGHT; y++) {
      for (let x = 0; x < FBO_WIDTH; x++) {
        uvs[i++] = (x + 0.5) / FBO_WIDTH;
        uvs[i++] = (y + 0.5) / FBO_HEIGHT;
        uvs[i++] = 0;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(uvs, 3));
    return geo;
  }

  function initPositions() {
    // Random sphere distribution
    const data = new Float32Array(FBO_WIDTH * FBO_HEIGHT * 4);
    for (let i = 0; i < FBO_WIDTH * FBO_HEIGHT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 0.3 + Math.random() * 0.5;
      data[i * 4 + 0] = Math.sin(phi) * Math.cos(theta) * r;
      data[i * 4 + 1] = Math.sin(phi) * Math.sin(theta) * r;
      data[i * 4 + 2] = Math.cos(phi) * r;
      data[i * 4 + 3] = 1;
    }
    const tex = new THREE.DataTexture(data, FBO_WIDTH, FBO_HEIGHT, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    return tex;
  }

  function createQuad(mat) {
    const geo = new THREE.PlaneGeometry(2, 2);
    return new THREE.Mesh(geo, mat);
  }

  // ── Public API ───────────────────────────────────────────────

  function init() {
    const canvas = document.getElementById('ambient-canvas');
    if (!canvas) return;

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.autoClear = false;

    // Check for required extensions
    const gl = renderer.getContext();
    if (!gl.getExtension('OES_texture_float')) {
      console.warn('[Ambient] OES_texture_float not supported — falling back');
      return;
    }

    clock = new THREE.Clock();

    // Camera — orthographic for fullscreen quad passes
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ── FBO Setup ──
    positionFBO  = createFBO(FBO_WIDTH, FBO_HEIGHT);
    positionFBO2 = createFBO(FBO_WIDTH, FBO_HEIGHT);
    trailFBO     = createFBO(window.innerWidth, window.innerHeight, THREE.HalfFloatType);
    trailFBO2    = createFBO(window.innerWidth, window.innerHeight, THREE.HalfFloatType);

    // Particle render target (not FBO, just temp)
    const particleRT = createFBO(window.innerWidth, window.innerHeight, THREE.HalfFloatType);

    // ── Simulation shader ──
    simMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPosition:   { value: initPositions() },
        uTime:       { value: 0 },
        uDeltaTime:  { value: 0.016 },
        uLoudness:   { value: 0 },
        uCentroid:   { value: 0 },
        uBeat:       { value: 0 },
        uMelBass:    { value: 0 },
        uMelMid:     { value: 0 },
      },
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
    });
    quadMesh = createQuad(simMaterial);
    scene = new THREE.Scene();
    scene.add(quadMesh);

    // ── Particle render ──
    particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPosition:    { value: null },
        uMelBass:     { value: 0 },
        uLoudness:    { value: 0 },
        uBeat:        { value: 0 },
        uColorTop:    { value: new THREE.Vector3(0.2, 0.5, 0.9) },
        uColorBottom: { value: new THREE.Vector3(0.05, 0.05, 0.12) },
      },
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
    });

    const particleGeo = createParticleUVs();
    const particleScene = new THREE.Scene();
    particleScene.add(new THREE.Points(particleGeo, particleMaterial));

    // ── Trail / persistence shader ──
    trailMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uParticles: { value: null },
        uTrail:     { value: null },
        uDecay:     { value: TRAIL_DECAY },
      },
      vertexShader:   TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
    });
    trailQuad = createQuad(trailMaterial);
    const trailScene = new THREE.Scene();
    trailScene.add(trailQuad);

    // ── Final composite shader ──
    const finalMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTrail:      { value: null },
        uRes:        { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uBrightness: { value: 1.0 },
      },
      vertexShader:   TRAIL_VERT,
      fragmentShader: FINAL_FRAG,
    });
    const finalQuad = createQuad(finalMaterial);
    const finalScene = new THREE.Scene();
    finalScene.add(finalQuad);

    // ── Particle render target for this frame ──
    const particleCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    particleCamera.position.z = 2.2;

    // Resize
    window.addEventListener('resize', () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      trailFBO.setSize(window.innerWidth, window.innerHeight);
      trailFBO2.setSize(window.innerWidth, window.innerHeight);
      particleRT.setSize(window.innerWidth, window.innerHeight);
      particleCamera.aspect = window.innerWidth / window.innerHeight;
      particleCamera.updateProjectionMatrix();
      finalMaterial.uniforms.uRes.value.set(window.innerWidth, window.innerHeight);
    });

    initialized = true;

    // ── Render Loop ──
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      const now = performance.now();
      const dt  = Math.min((now - lastFrameTime) / 1000, 0.05);
      lastFrameTime = now;
      const elapsed = clock.getElapsedTime();

      // Lerp audio features toward GradientController values (smooth)
      if (window.GradientController) {
        const gfx = GradientController.gfx;
        GradientController.frame(dt);

        uLoudness  += (gfx.intensity - 1.0 - uLoudness)    * dt * 6;
        beatPulse   = gfx.pulse;
        uCentroid  += (gfx.topColor[0] * 0.5 - uCentroid)  * dt * 5;

        // Update palette
        paletteTop.fromArray(gfx.topColor);
        paletteBottom.fromArray(gfx.bottomColor);
      }

      // Lerp palette
      targetTop.lerp(paletteTop, dt * 3);
      targetBottom.lerp(paletteBottom, dt * 3);

      // ── PASS 1: Simulate positions ──
      simMaterial.uniforms.uTime.value       = elapsed;
      simMaterial.uniforms.uDeltaTime.value  = dt;
      simMaterial.uniforms.uLoudness.value   = Math.max(0, uLoudness);
      simMaterial.uniforms.uCentroid.value   = uCentroid;
      simMaterial.uniforms.uBeat.value       = beatPulse;
      simMaterial.uniforms.uMelBass.value    = uMelbands[0];
      simMaterial.uniforms.uMelMid.value     = uMelbands[3];

      quadMesh.material = simMaterial;
      renderer.setRenderTarget(positionFBO2);
      renderer.render(scene, camera);

      // Swap position FBOs
      [positionFBO, positionFBO2] = [positionFBO2, positionFBO];
      simMaterial.uniforms.uPosition.value = positionFBO.texture;

      // ── PASS 2: Render particles to temp buffer ──
      particleMaterial.uniforms.uPosition.value    = positionFBO.texture;
      particleMaterial.uniforms.uMelBass.value      = uMelbands[0];
      particleMaterial.uniforms.uLoudness.value     = Math.max(0, uLoudness);
      particleMaterial.uniforms.uBeat.value         = beatPulse;
      particleMaterial.uniforms.uColorTop.value.fromArray(targetTop.toArray());
      particleMaterial.uniforms.uColorBottom.value.fromArray(targetBottom.toArray());

      renderer.setRenderTarget(particleRT);
      renderer.clear();
      renderer.render(particleScene, particleCamera);

      // ── PASS 3: Trail / persistence feedback ──
      trailMaterial.uniforms.uParticles.value = particleRT.texture;
      trailMaterial.uniforms.uTrail.value     = trailFBO2.texture;
      trailMaterial.uniforms.uDecay.value     = TRAIL_DECAY - uLoudness * 0.03;
      trailQuad.material = trailMaterial;

      renderer.setRenderTarget(trailFBO);
      renderer.render(trailScene, camera);

      // Swap trail FBOs
      [trailFBO, trailFBO2] = [trailFBO2, trailFBO];

      // ── PASS 4: Final composite to screen ──
      finalMaterial.uniforms.uTrail.value      = trailFBO.texture;
      finalMaterial.uniforms.uBrightness.value = 0.85 + Math.max(0, uLoudness) * 0.4;
      finalQuad.material = finalMaterial;

      renderer.setRenderTarget(null);
      renderer.render(finalScene, camera);
    }

    renderLoop();
  }

  function setSong(songName, artistName, token) {
    reset();
    // Fetch mood data to set palette
    if (!token) return;
    fetch(`https://onesong.onrender.com/mood?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(r => r.json())
    .then(data => {
      if (data.tags && window.GradientController) {
        const tags = data.tags;
        // Map tags to palettes
        const PALETTES = {
          'sad':        { top: [0.2, 0.3, 0.6], bot: [0.0, 0.0, 0.05] },
          'happy':      { top: [1.0, 0.8, 0.2], bot: [0.4, 0.0, 0.1] },
          'electronic': { top: [0.9, 0.2, 1.0], bot: [0.0, 0.0, 0.1] },
          'chill':      { top: [0.4, 0.8, 0.6], bot: [0.05, 0.1, 0.05] },
          'rock':       { top: [0.9, 0.3, 0.1], bot: [0.1, 0.0, 0.0] },
          'pop':        { top: [1.0, 0.5, 0.7], bot: [0.2, 0.0, 0.2] },
          'jazz':       { top: [0.8, 0.6, 0.2], bot: [0.1, 0.05, 0.0] },
          'classical':  { top: [0.9, 0.9, 0.8], bot: [0.1, 0.1, 0.15] },
        };
        for (const tag of tags) {
          const p = PALETTES[tag];
          if (p) {
            GradientController.setBasePalette(p.top, p.bot);
            break;
          }
        }
        // Hash fallback
        if (!tags.some(t => PALETTES[t])) {
          const hash = [...songName].reduce((a, c) => a * 31 + c.charCodeAt(0), 0);
          const hue  = Math.abs(hash % 360) / 360;
          const h2r  = (h, s, l) => {
            const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
            const hue2rgb = (p,q,t) => { t=((t%1)+1)%1; if(t<1/6)return p+(q-p)*6*t; if(t<0.5)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
            return [hue2rgb(p,q,h+1/3), hue2rgb(p,q,h), hue2rgb(p,q,h-1/3)];
          };
          GradientController.setBasePalette(h2r(hue,0.9,0.6), h2r((hue+0.5)%1,0.8,0.08));
        }
      }
    })
    .catch(() => {});
  }

  function startBeat() { isPlaying = true; if (window.GradientController) GradientController.updatePlayhead(0, true); }
  function stopBeat()  { isPlaying = false; if (window.GradientController) GradientController.updatePlayhead(0, false); }

  function syncBeat() {
    if (window.GradientController) GradientController.triggerBeat();
    uMelbands[0] = Math.min(1, uMelbands[0] + 0.5);
    setTimeout(() => { uMelbands[0] *= 0.3; }, 150);
  }

  function reset() {
    uLoudness = 0; uCentroid = 0; uMelbands.fill(0); beatPulse = 0;
    if (window.GradientController) GradientController.reset();
    // Clear trail FBOs
    if (trailFBO && renderer) {
      renderer.setRenderTarget(trailFBO);  renderer.clear();
      renderer.setRenderTarget(trailFBO2); renderer.clear();
      renderer.setRenderTarget(null);
    }
  }

  return { init, setSong, startBeat, stopBeat, syncBeat, reset };
})();