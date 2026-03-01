/**
 * ambient.js — GPGPU Flow Field Visualizer  v2.1 (FIXED)
 * Three.js r128 · 512×256 FBO ping-pong · Curl Noise · Persistence trails
 *
 * BUG FIXES vs v2.0:
 *   [1] OES_texture_float failure now falls back to HalfFloat instead of silently dying
 *   [2] uVelocity was MISSING from simMaterial uniforms — positions never updated
 *   [3] Added separate velocity FBO ping-pong (position & velocity now properly decoupled)
 *   [4] FBOs primed with initial DataTexture before first render (no uninitialised GPU reads)
 *   [5] THREE.Color.lerp() factor clamped to [0,1]; was dt*3 which overshoots → freeze
 *   [6] uColorTop/uColorBot set via .set(r,g,b) — no broken .toArray() needed
 *   [7] Canvas z-index forced to -1 via JS so it's always behind UI
 *   [8] velMaterial shares simUniforms object so audio values propagate to both passes
 */

const Ambient = (() => {

  const FBO_W = 512, FBO_H = 256;
  const TRAIL_DECAY = 0.962;

  // Module-level refs (captured by renderLoop closure)
  let renderer, clock;
  let simScene, velScene, particleScene, trailScene, finalScene;
  let particleCamera;
  let simMaterial, velMaterial, particleMaterial, trailMaterial, finalMaterial;
  let posA, posB, velA, velB, trailA, trailB, particleRT;
  let initialized = false;

  // Audio state
  let uLoudness = 0, uCentroid = 0, beatPulse = 0;
  let uMelbands = new Float32Array(8);
  let lastT = performance.now();

  // Palette colours — THREE.Color for proper lerp
  let palTop = new THREE.Color(0.06, 0.12, 0.35);
  let palBot = new THREE.Color(0.02, 0.02, 0.08);

  // ── GLSL: 3D Simplex + Curl Noise ──────────────────────────────
  const NOISE = /* glsl */`
    vec3 m289(vec3 x){return x-floor(x/289.)*289.;}
    vec4 m289(vec4 x){return x-floor(x/289.)*289.;}
    vec4 perm(vec4 x){return m289((x*34.+1.)*x);}
    vec4 tis(vec4 r){return 1.7928429-.8537347*r;}

    float snoise(vec3 v){
      const vec2 C=vec2(.166667,.333333);
      vec3 i=floor(v+dot(v,C.yyy)), x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz), l=1.-g;
      vec3 i1=min(g,l.zxy), i2=max(g,l.zxy);
      vec3 x1=x0-i1+C.xxx, x2=x0-i2+C.yyy, x3=x0-.5;
      i=m289(i);
      vec4 p=perm(perm(perm(i.z+vec4(0,i1.z,i2.z,1))+i.y+vec4(0,i1.y,i2.y,1))+i.x+vec4(0,i1.x,i2.x,1));
      vec3 ns=.142857*vec3(0,1,2)-vec3(.333333);
      vec4 j=p-49.*floor(p*.020408);
      vec4 x_=floor(j*.142857), y_=floor(j-7.*x_);
      vec4 x=x_*.142857+ns.y, y=y_*.142857+ns.y, h=1.-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy), b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.+1., s1=floor(b1)*2.+1., sh=-step(h,vec4(0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy, a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x),p1=vec3(a0.zw,h.y),p2=vec3(a1.xy,h.z),p3=vec3(a1.zw,h.w);
      vec4 norm=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
      vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
      m*=m; return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    vec3 curl(vec3 p){
      const float e=.0001;
      // Analytically compute curl of gradient noise field
      float A=snoise(p+vec3(0,e,0))-snoise(p-vec3(0,e,0));
      float B=snoise(p+vec3(0,0,e))-snoise(p-vec3(0,0,e));
      float C=snoise(p+vec3(e,0,0))-snoise(p-vec3(e,0,0));
      float D=snoise(p+vec3(0,e,0))-snoise(p-vec3(0,e,0));
      return vec3(A-B, B-C, C-D) / (2.*e);
    }
  `;

  // ── Shared simulation uniforms (both position & velocity passes read these) ──
  // Declared OUTSIDE materials so both ShaderMaterials reference the SAME objects
  const SIM_UNI = {
    uPos: {value:null}, uVel:{value:null},
    uTime:{value:0}, uDt:{value:.016},
    uLoudness:{value:0}, uCentroid:{value:0},
    uBeat:{value:0}, uMelBass:{value:0}, uMelMid:{value:0},
  };

  const QUAD_V = /* glsl */`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;

  const SIM_F = /* glsl */`
    precision highp float;
    uniform sampler2D uPos, uVel;
    uniform float uTime,uDt,uLoudness,uCentroid,uBeat,uMelBass,uMelMid;
    varying vec2 vUv;
    ${NOISE}
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5);}
    void main(){
      vec3 pos=texture2D(uPos,vUv).xyz;
      vec3 vel=texture2D(uVel,vUv).xyz;
      float freq=.75+uCentroid*2.8, spd=.25+uLoudness*2.+uMelBass*.9;
      vec3 np=pos*freq+vec3(uTime*.11,uTime*.07,uTime*.09);
      vec3 c=curl(np)*spd;
      c.y+=uMelMid*snoise(pos*1.8+vec3(0,uTime*.18,0))*.5;
      vel+=normalize(pos+.0001)*uBeat*3.*exp(-length(pos)*2.);
      vel+=(c-vel*.55)*uDt*2.8; vel*=.982;
      float d=length(pos);
      if(d>1.1)vel-=normalize(pos)*(d-1.1)*1.2*uDt;
      pos+=vel*uDt;
      float r1=h(vUv),r2=h(vUv+vec2(3.7,9.2));
      if(d>1.7||dot(vel,vel)<1e-8){
        float th=r1*6.283,ph=acos(2.*r2-1.),rr=.35+r1*.45;
        pos=vec3(sin(ph)*cos(th)*rr,sin(ph)*sin(th)*rr,cos(ph)*rr);
        vel=vec3(0);
      }
      gl_FragColor=vec4(pos,length(vel));
    }
  `;

  const VEL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uPos,uVel;
    uniform float uTime,uDt,uLoudness,uCentroid,uBeat,uMelBass,uMelMid;
    varying vec2 vUv;
    ${NOISE}
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5);}
    void main(){
      vec3 pos=texture2D(uPos,vUv).xyz;
      vec3 vel=texture2D(uVel,vUv).xyz;
      float freq=.75+uCentroid*2.8,spd=.25+uLoudness*2.+uMelBass*.9;
      vec3 np=pos*freq+vec3(uTime*.11,uTime*.07,uTime*.09);
      vec3 c=curl(np)*spd;
      c.y+=uMelMid*snoise(pos*1.8+vec3(0,uTime*.18,0))*.5;
      vel+=normalize(pos+.0001)*uBeat*3.*exp(-length(pos)*2.);
      vel+=(c-vel*.55)*uDt*2.8; vel*=.982;
      float d=length(pos);
      if(d>1.1)vel-=normalize(pos)*(d-1.1)*1.2*uDt;
      float r1=h(vUv),r2=h(vUv+vec2(3.7,9.2));
      if(d>1.7||dot(vel,vel)<1e-8)vel=vec3(0);
      gl_FragColor=vec4(vel,1);
    }
  `;

  const PART_V = /* glsl */`
    uniform sampler2D uPos;
    uniform float uMelBass,uLoudness,uBeat;
    uniform vec3 uColorTop,uColorBot;
    varying vec3 vCol; varying float vA;
    void main(){
      vec4 t=texture2D(uPos,position.xy);
      vec3 pos=t.xyz; float vm=t.w;
      vec4 mv=modelViewMatrix*vec4(pos,1.);
      gl_Position=projectionMatrix*mv;
      float sz=1.2+uMelBass*2.8+uBeat*1.8;
      gl_PointSize=sz*(280./max(-mv.z,.1));
      float yt=clamp(pos.y*.5+.5,0.,1.);
      vCol=mix(uColorBot,uColorTop,yt)+uColorTop*uBeat*.15;
      vA=clamp(.35+vm*.4+uLoudness*.45,.05,1.);
    }
  `;

  const PART_F = /* glsl */`
    precision highp float;
    varying vec3 vCol; varying float vA;
    void main(){
      vec2 d=gl_PointCoord-.5; float r=length(d);
      if(r>.5)discard;
      float e=1.-r*2.;
      gl_FragColor=vec4(vCol*(1.+e*.9),e*e*vA);
    }
  `;

  const TRAIL_QV = /* glsl */`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;

  const TRAIL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uParticles,uTrail; uniform float uDecay;
    varying vec2 vUv;
    void main(){ gl_FragColor=clamp(texture2D(uTrail,vUv)*uDecay+texture2D(uParticles,vUv),0.,1.); }
  `;

  const FINAL_F = /* glsl */`
    precision highp float;
    uniform sampler2D uTrail; uniform float uBright;
    varying vec2 vUv;
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    void main(){
      vec2 off=(vUv-.5)*.006;
      vec3 c=vec3(texture2D(uTrail,vUv+off).r, texture2D(uTrail,vUv).g, texture2D(uTrail,vUv-off).b);
      c=aces(c*uBright);
      vec2 uv2=vUv-.5;
      c*=clamp(1.-dot(uv2,uv2)*1.6,0.,1.);
      gl_FragColor=vec4(c,1.);
    }
  `;

  // ── Helpers ──────────────────────────────────────────────────
  function fbo(w, h, type) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter:THREE.NearestFilter, magFilter:THREE.NearestFilter,
      format:THREE.RGBAFormat, type, depthBuffer:false, stencilBuffer:false,
    });
  }

  function quad(mat) {
    return new THREE.Mesh(new THREE.PlaneGeometry(2,2), mat);
  }

  function dataTex(data, type) {
    const t = new THREE.DataTexture(data, FBO_W, FBO_H, THREE.RGBAFormat, type);
    t.needsUpdate = true;
    return t;
  }

  // Prime an FBO by blitting a DataTexture into it on first frame
  function prime(target, tex, cam) {
    const sc = new THREE.Scene();
    sc.add(quad(new THREE.MeshBasicMaterial({map:tex})));
    renderer.setRenderTarget(target);
    renderer.render(sc, cam);
  }

  // ── PUBLIC: init ─────────────────────────────────────────────
  function init() {
    if (initialized) return;

    const canvas = document.getElementById('ambient-canvas');
    if (!canvas) { console.error('[Ambient] canvas not found'); return; }

    // FIX [7]: ensure canvas is always behind UI
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;display:block;';

    renderer = new THREE.WebGLRenderer({ canvas, antialias:false, alpha:false, powerPreference:'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.autoClear = false;

    const gl = renderer.getContext();

    // FIX [1]: graceful extension fallback
    const hasF  = !!gl.getExtension('OES_texture_float');
    const hasHF = !!gl.getExtension('OES_texture_half_float');
    if (!hasF && !hasHF) {
      canvas.style.background = 'radial-gradient(ellipse at 50% 60%,#0a0a2e 0%,#000008 100%)';
      console.warn('[Ambient] No float texture support — CSS gradient fallback active');
      return;
    }
    const sType = hasF ? THREE.FloatType : THREE.HalfFloatType;
    const tType = THREE.HalfFloatType;

    clock = new THREE.Clock();
    const ortho = new THREE.OrthographicCamera(-1,1,1,-1,0,1);

    // ── FBO allocation ──
    posA = fbo(FBO_W, FBO_H, sType); posB = fbo(FBO_W, FBO_H, sType);
    velA = fbo(FBO_W, FBO_H, sType); velB = fbo(FBO_W, FBO_H, sType);
    trailA = fbo(innerWidth, innerHeight, tType);
    trailB = fbo(innerWidth, innerHeight, tType);
    particleRT = fbo(innerWidth, innerHeight, tType);

    // FIX [4]: prime position FBOs with initial sphere distribution
    const posData = new Float32Array(FBO_W * FBO_H * 4);
    for (let i = 0; i < FBO_W * FBO_H; i++) {
      const th=Math.random()*Math.PI*2, ph=Math.acos(2*Math.random()-1), r=.25+Math.random()*.55;
      posData[i*4]  = Math.sin(ph)*Math.cos(th)*r;
      posData[i*4+1]= Math.sin(ph)*Math.sin(th)*r;
      posData[i*4+2]= Math.cos(ph)*r;
      posData[i*4+3]= .001;
    }
    const initPos = dataTex(posData, sType);
    const initVel = dataTex(new Float32Array(FBO_W*FBO_H*4), sType);

    prime(posA, initPos, ortho); prime(posB, initPos, ortho);
    prime(velA, initVel, ortho); prime(velB, initVel, ortho);

    // ── Sim material (position pass) ──
    // FIX [2]: uVel now present; FIX [8]: both mats share SIM_UNI reference
    SIM_UNI.uPos.value = posA.texture;
    SIM_UNI.uVel.value = velA.texture;

    simMaterial = new THREE.ShaderMaterial({ uniforms:SIM_UNI, vertexShader:QUAD_V, fragmentShader:SIM_F });
    simScene = new THREE.Scene(); simScene.add(quad(simMaterial));

    // ── Velocity material ──
    velMaterial = new THREE.ShaderMaterial({ uniforms:SIM_UNI, vertexShader:QUAD_V, fragmentShader:VEL_F });
    velScene = new THREE.Scene(); velScene.add(quad(velMaterial));

    // ── Particle material ──
    particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPos:{value:posA.texture}, uMelBass:{value:0}, uLoudness:{value:0}, uBeat:{value:0},
        uColorTop:{value:new THREE.Vector3(.2,.5,.9)},
        uColorBot:{value:new THREE.Vector3(.05,.05,.12)},
      },
      vertexShader:PART_V, fragmentShader:PART_F,
      transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false,
    });

    // Per-particle UV geometry (each vertex = UV into position FBO)
    const uvArr = new Float32Array(FBO_W*FBO_H*3);
    for (let y=0,k=0; y<FBO_H; y++) for (let x=0; x<FBO_W; x++) {
      uvArr[k++]=(x+.5)/FBO_W; uvArr[k++]=(y+.5)/FBO_H; uvArr[k++]=0;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(uvArr,3));
    particleScene = new THREE.Scene();
    particleScene.add(new THREE.Points(pGeo, particleMaterial));
    particleCamera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, .01, 100);
    particleCamera.position.z = 2.2;

    // ── Trail material ──
    trailMaterial = new THREE.ShaderMaterial({
      uniforms:{uParticles:{value:null},uTrail:{value:null},uDecay:{value:TRAIL_DECAY}},
      vertexShader:TRAIL_QV, fragmentShader:TRAIL_F,
    });
    trailScene = new THREE.Scene(); trailScene.add(quad(trailMaterial));

    // ── Final composite ──
    finalMaterial = new THREE.ShaderMaterial({
      uniforms:{uTrail:{value:null},uBright:{value:1.}},
      vertexShader:TRAIL_QV, fragmentShader:FINAL_F,
    });
    finalScene = new THREE.Scene(); finalScene.add(quad(finalMaterial));

    // Resize
    window.addEventListener('resize', () => {
      const w=innerWidth, h=innerHeight;
      renderer.setSize(w,h);
      trailA.setSize(w,h); trailB.setSize(w,h); particleRT.setSize(w,h);
      particleCamera.aspect=w/h; particleCamera.updateProjectionMatrix();
    });

    initialized = true;

    // ── 4-PASS RENDER LOOP ────────────────────────────────────
    ;(function loop() {
      requestAnimationFrame(loop);
      const now=performance.now(), dt=Math.min((now-lastT)/1000,.05);
      lastT=now;
      const t=clock.getElapsedTime();

      // Read GradientController state
      if (window.GradientController) {
        GradientController.frame(dt);
        const g=GradientController.gfx;
        // FIX [5]: lerp factor clamped — was (dt*3) which overshoots to 1+ and freezes
        const a=Math.min(dt*2.5, 1.0);
        uLoudness += (Math.max(0, g.intensity-1.0) - uLoudness) * Math.min(dt*8,.5);
        beatPulse   = g.pulse;
        uCentroid  += (g.centroid - uCentroid) * Math.min(dt*6,.5);
        palTop.lerp (new THREE.Color(g.topColor[0],   g.topColor[1],   g.topColor[2]),   a);
        palBot.lerp (new THREE.Color(g.bottomColor[0],g.bottomColor[1],g.bottomColor[2]), a);
      }

      // Update shared uniforms
      SIM_UNI.uTime.value=t; SIM_UNI.uDt.value=dt;
      SIM_UNI.uLoudness.value=uLoudness; SIM_UNI.uCentroid.value=uCentroid;
      SIM_UNI.uBeat.value=beatPulse; SIM_UNI.uMelBass.value=uMelbands[0]; SIM_UNI.uMelMid.value=uMelbands[3];

      // PASS 1a — velocity update
      SIM_UNI.uPos.value=posA.texture; SIM_UNI.uVel.value=velA.texture;
      renderer.setRenderTarget(velB); renderer.render(velScene, ortho);
      [velA,velB]=[velB,velA];

      // PASS 1b — position update (FIX [3]: uses freshly updated velocity)
      SIM_UNI.uPos.value=posA.texture; SIM_UNI.uVel.value=velA.texture;
      renderer.setRenderTarget(posB); renderer.render(simScene, ortho);
      [posA,posB]=[posB,posA];

      // PASS 2 — render particles to intermediate buffer
      particleMaterial.uniforms.uPos.value=posA.texture;
      particleMaterial.uniforms.uMelBass.value=uMelbands[0];
      particleMaterial.uniforms.uLoudness.value=uLoudness;
      particleMaterial.uniforms.uBeat.value=beatPulse;
      // FIX [6]: set Vector3 via .set() — no broken .toArray() call
      particleMaterial.uniforms.uColorTop.value.set(palTop.r, palTop.g, palTop.b);
      particleMaterial.uniforms.uColorBot.value.set(palBot.r, palBot.g, palBot.b);
      renderer.setRenderTarget(particleRT); renderer.clear();
      renderer.render(particleScene, particleCamera);

      // PASS 3 — trail feedback
      trailMaterial.uniforms.uParticles.value=particleRT.texture;
      trailMaterial.uniforms.uTrail.value=trailB.texture;
      trailMaterial.uniforms.uDecay.value=TRAIL_DECAY-uLoudness*.025;
      renderer.setRenderTarget(trailA); renderer.render(trailScene, ortho);
      [trailA,trailB]=[trailB,trailA];

      // PASS 4 — composite to screen
      finalMaterial.uniforms.uTrail.value=trailA.texture;
      finalMaterial.uniforms.uBright.value=.88+uLoudness*.45;
      renderer.setRenderTarget(null); renderer.render(finalScene, ortho);
    })();
  }

  // ── PUBLIC: setSong ──────────────────────────────────────────
  function setSong(name, artist, token) {
    reset();
    if (!token) return;
    const P={
      sad:{top:[.15,.25,.55],bot:[0,0,.04]}, happy:{top:[1,.78,.15],bot:[.35,.02,.08]},
      electronic:{top:[.85,.15,.98],bot:[0,0,.1]}, chill:{top:[.35,.78,.58],bot:[.04,.1,.04]},
      rock:{top:[.9,.28,.08],bot:[.1,0,0]}, pop:{top:[.98,.45,.68],bot:[.18,0,.18]},
      jazz:{top:[.82,.58,.18],bot:[.1,.04,0]}, classical:{top:[.9,.88,.8],bot:[.08,.08,.13]},
      metal:{top:[.6,.1,.1],bot:[.05,0,0]}, ambient:{top:[.1,.4,.7],bot:[.02,.04,.08]},
    };
    function hp(s){
      const h=[...s].reduce((a,c)=>((a<<5)-a)+c.charCodeAt(0),0), hue=Math.abs(h%360)/360;
      const f=(h,s,l)=>{const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q,t=e=>((e%1)+1)%1;
        return[1/6,1/2,2/3].map((v,i)=>{const e=i===0?t(hue+1/3):i===1?hue:t(hue-1/3);return e<1/6?p+(q-p)*6*e:e<.5?q:e<2/3?p+(q-p)*(2/3-e)*6:p;});};
      return{top:f(hue,.9,.6),bot:f((hue+.5)%1,.8,.07)};
    }
    fetch(`https://onesong.onrender.com/mood?track=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`,
      {headers:{'Authorization':`Bearer ${token}`}})
    .then(r=>r.ok?r.json():{tags:[]})
    .then(({tags=[]})=>{
      let pal=null;
      for(const tag of tags){if(P[tag]){pal=P[tag];break;}}
      if(!pal)pal=hp(name);
      if(window.GradientController)GradientController.setBasePalette(pal.top,pal.bot);
    }).catch(()=>{});
  }

  function startBeat(){if(window.GradientController)GradientController.updatePlayhead(0,true);}
  function stopBeat() {if(window.GradientController)GradientController.updatePlayhead(0,false);}
  function syncBeat() {
    if(window.GradientController)GradientController.triggerBeat();
    uMelbands[0]=Math.min(1,uMelbands[0]+.6);
    setTimeout(()=>{uMelbands[0]*=.2;},120);
  }

  function reset(){
    uLoudness=0;uCentroid=0;beatPulse=0;uMelbands.fill(0);
    if(window.GradientController)GradientController.reset();
    if(renderer&&trailA&&trailB){
      renderer.setRenderTarget(trailA);renderer.clear();
      renderer.setRenderTarget(trailB);renderer.clear();
      renderer.setRenderTarget(null);
    }
  }

  return {init,setSong,startBeat,stopBeat,syncBeat,reset};
})();