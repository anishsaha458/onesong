// ─────────────────────────────────────────────────────────────
// AMBIENT ENGINE v2 — Last.fm tag-driven visual mood system
//
// Flow:
//   song name + artist → /mood endpoint → Last.fm tags
//   → keyword mapper → palette → WebGL fluid shader
//
// Falls back to a hash-based palette if tags are unavailable.
// ─────────────────────────────────────────────────────────────

const Ambient = (() => {

  let canvas, gl, program;
  let startTime = Date.now();
  let uniforms  = {};
  let currentPalette = null;
  let targetPalette  = null;
  let lerpT = 1;

  const DEFAULT = {
    colors:     [[0.08,0.06,0.12],[0.14,0.10,0.22],[0.06,0.08,0.16]],
    speed:      0.18,
    turbulence: 0.55,
    pulseRate:  0.6,
    orbCount:   3.0,
    brightness: 0.55,
  };

  // ── TAG → MOOD RULES ───────────────────────────────────────
  const MOOD_RULES = [
    {
      keys: ['sad','melancholic','melancholy','heartbreak','heartbroken',
             'grief','loss','lonely','loneliness','depression','depressive',
             'somber','sombre','tearful','crying','wistful','bittersweet'],
      palette: {
        colors: [[0.04,0.06,0.18],[0.08,0.12,0.30],[0.10,0.08,0.22]],
        speed: 0.10, turbulence: 0.45, pulseRate: 0.35, orbCount: 2, brightness: 0.42,
      }
    },
    {
      keys: ['happy','happiness','joyful','joy','uplifting','upbeat',
             'feel-good','feel good','positive','cheerful','fun','playful',
             'sunny','bright','celebratory','euphoric','euphoria'],
      palette: {
        colors: [[0.30,0.18,0.04],[0.40,0.28,0.06],[0.20,0.24,0.08]],
        speed: 0.30, turbulence: 0.65, pulseRate: 1.4, orbCount: 5, brightness: 0.82,
      }
    },
    {
      keys: ['energetic','energy','intense','intensity','powerful','power',
             'aggressive','aggression','hard','heavy','driving','epic',
             'stadium','anthemic','anthem','pump up','hype','bangers'],
      palette: {
        colors: [[0.35,0.05,0.04],[0.50,0.12,0.03],[0.28,0.08,0.15]],
        speed: 0.38, turbulence: 1.10, pulseRate: 1.80, orbCount: 6, brightness: 0.80,
      }
    },
    {
      keys: ['chill','chillout','chill out','calm','calming','relaxing',
             'relax','peaceful','serene','tranquil','gentle','soft',
             'mellow','laid back','laid-back','easy','easy listening'],
      palette: {
        colors: [[0.04,0.14,0.18],[0.06,0.20,0.22],[0.04,0.12,0.16]],
        speed: 0.10, turbulence: 0.35, pulseRate: 0.30, orbCount: 3, brightness: 0.50,
      }
    },
    {
      keys: ['love','romantic','romance','sensual','passion','passionate',
             'intimate','intimacy','crush','longing','desire','tender',
             'sweet','adore','devotion','soulmate'],
      palette: {
        colors: [[0.28,0.06,0.14],[0.38,0.10,0.20],[0.20,0.06,0.18]],
        speed: 0.14, turbulence: 0.42, pulseRate: 0.70, orbCount: 3, brightness: 0.58,
      }
    },
    {
      keys: ['dark','darkness','ominous','sinister','evil','villain',
             'gothic','goth','horror','haunting','haunt','eerie','creepy',
             'noir','shadow','doom','doomy','foreboding','dread'],
      palette: {
        colors: [[0.06,0.02,0.10],[0.12,0.04,0.16],[0.04,0.04,0.08]],
        speed: 0.12, turbulence: 0.80, pulseRate: 0.45, orbCount: 2, brightness: 0.32,
      }
    },
    {
      keys: ['dreamy','dream','ethereal','surreal','hazy','atmospheric',
             'ambient','space','cosmic','celestial','float','floating',
             'transcendent','psychedelic','trippy','hypnotic'],
      palette: {
        colors: [[0.12,0.08,0.28],[0.18,0.12,0.35],[0.08,0.14,0.30]],
        speed: 0.13, turbulence: 0.60, pulseRate: 0.50, orbCount: 4, brightness: 0.55,
      }
    },
    {
      keys: ['nostalgic','nostalgia','retro','vintage','classic','oldschool',
             'old school','throwback','memories','memory','childhood',
             '80s','90s','70s','60s','timeless'],
      palette: {
        colors: [[0.28,0.18,0.08],[0.22,0.14,0.10],[0.18,0.12,0.16]],
        speed: 0.14, turbulence: 0.40, pulseRate: 0.55, orbCount: 3, brightness: 0.60,
      }
    },
    {
      keys: ['electronic','electro','dance','edm','techno','house',
             'trance','rave','synth','synthwave','disco','club','dj',
             'beats','bass','dubstep','drum and bass','dnb'],
      palette: {
        colors: [[0.04,0.20,0.30],[0.10,0.30,0.40],[0.20,0.06,0.35]],
        speed: 0.35, turbulence: 0.90, pulseRate: 1.60, orbCount: 5, brightness: 0.75,
      }
    },
    {
      keys: ['acoustic','folk','organic','natural','earthy','unplugged',
             'singer-songwriter','singer songwriter','campfire','roots',
             'bluegrass','country','americana','wholesome'],
      palette: {
        colors: [[0.18,0.14,0.06],[0.22,0.16,0.08],[0.14,0.12,0.06]],
        speed: 0.12, turbulence: 0.38, pulseRate: 0.50, orbCount: 2, brightness: 0.58,
      }
    },
    {
      keys: ['hip hop','hiphop','hip-hop','rap','trap','urban','street',
             'gritty','swagger','bounce','flow','rhyme','bars'],
      palette: {
        colors: [[0.08,0.08,0.08],[0.20,0.16,0.04],[0.14,0.06,0.06]],
        speed: 0.22, turbulence: 0.70, pulseRate: 1.10, orbCount: 4, brightness: 0.62,
      }
    },
    {
      keys: ['classical','orchestral','orchestra','symphony','symphonic',
             'chamber','piano','violin','cello','baroque','opera','choral',
             'majestic','grand','sweeping','cinematic'],
      palette: {
        colors: [[0.16,0.12,0.22],[0.22,0.18,0.28],[0.12,0.14,0.20]],
        speed: 0.13, turbulence: 0.50, pulseRate: 0.55, orbCount: 3, brightness: 0.62,
      }
    },
    {
      keys: ['angry','anger','rage','defiant','defiance','rebel','protest',
             'revolution','fight','raw','visceral','furious','fury'],
      palette: {
        colors: [[0.40,0.04,0.02],[0.30,0.06,0.04],[0.20,0.04,0.08]],
        speed: 0.40, turbulence: 1.15, pulseRate: 1.90, orbCount: 5, brightness: 0.72,
      }
    },
    {
      keys: ['spiritual','devotional','gospel','sacred','holy','divine',
             'meditation','meditative','prayer','soul','soulful','grace',
             'uplifted','faith','religious'],
      palette: {
        colors: [[0.20,0.16,0.08],[0.28,0.22,0.10],[0.16,0.18,0.20]],
        speed: 0.10, turbulence: 0.35, pulseRate: 0.40, orbCount: 3, brightness: 0.65,
      }
    },
    {
      keys: ['rainy','rain','introspective','introspection','thoughtful',
             'reflective','reflection','contemplative','quiet','late night',
             'midnight','3am','night','insomnia','brooding'],
      palette: {
        colors: [[0.06,0.10,0.20],[0.10,0.14,0.26],[0.06,0.08,0.16]],
        speed: 0.11, turbulence: 0.42, pulseRate: 0.38, orbCount: 2, brightness: 0.44,
      }
    },
  ];

  function tagsToMood(tags) {
    if (!tags || tags.length === 0) return null;
    const matched = [];
    for (const rule of MOOD_RULES) {
      const hits = rule.keys.filter(k => tags.some(t => t.includes(k) || k.includes(t)));
      if (hits.length > 0) matched.push({ palette: rule.palette, weight: hits.length });
    }
    if (matched.length === 0) return null;

    const totalWeight = matched.reduce((s, m) => s + m.weight, 0);
    const blended = {
      colors: [[0,0,0],[0,0,0],[0,0,0]],
      speed: 0, turbulence: 0, pulseRate: 0, orbCount: 0, brightness: 0,
    };
    for (const { palette, weight } of matched) {
      const w = weight / totalWeight;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          blended.colors[i][j] += palette.colors[i][j] * w;
      blended.speed      += palette.speed      * w;
      blended.turbulence += palette.turbulence * w;
      blended.pulseRate  += palette.pulseRate  * w;
      blended.orbCount   += palette.orbCount   * w;
      blended.brightness += palette.brightness * w;
    }
    blended.orbCount = Math.round(blended.orbCount);
    return blended;
  }

  // ── Hash fallback ──────────────────────────────────────────
  function hashPalette(songName, artistName) {
    const str = (songName + artistName).toLowerCase();
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    const rand = (seed) => { let x = Math.sin(seed + h) * 43758.5453; return x - Math.floor(x); };
    const hue = rand(1) * 360;
    const hsl2rgb = (h, s, l) => {
      h /= 360; s /= 100; l /= 100;
      const a = s * Math.min(l, 1 - l);
      const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
      return [f(0), f(8), f(4)];
    };
    return {
      colors: [hsl2rgb(hue, 40, 12), hsl2rgb(hue+30, 45, 18), hsl2rgb(hue-20, 35, 10)],
      speed:      0.12 + rand(2) * 0.15,
      turbulence: 0.40 + rand(3) * 0.50,
      pulseRate:  0.40 + rand(4) * 0.80,
      orbCount:   2 + Math.round(rand(5) * 3),
      brightness: 0.45 + rand(6) * 0.25,
    };
  }

  // ── GLSL ───────────────────────────────────────────────────
  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;
  const FRAG = `
    precision highp float;
    uniform float u_time;
    uniform vec2  u_res;
    uniform vec3  u_c0, u_c1, u_c2;
    uniform float u_speed, u_turb, u_pulse, u_orbs, u_bright;

    vec3 hash3(vec2 p) {
      vec3 q=vec3(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)),dot(p,vec2(419.2,371.9)));
      return fract(sin(q)*43758.5453);
    }
    float noise(vec2 p) {
      vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      float a=dot(hash3(i),vec3(1,0,0)), b=dot(hash3(i+vec2(1,0)),vec3(1,0,0));
      float c=dot(hash3(i+vec2(0,1)),vec3(1,0,0)), d=dot(hash3(i+vec2(1,1)),vec3(1,0,0));
      return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
    }
    float fbm(vec2 p) {
      float v=0.0,a=0.5;
      for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=0.5;}
      return v;
    }
    void main() {
      vec2 uv=gl_FragCoord.xy/u_res; uv.x*=u_res.x/u_res.y;
      float t=u_time*u_speed;
      vec2 q=vec2(fbm(uv+t*0.4),fbm(uv+vec2(5.2,1.3)));
      vec2 r=vec2(fbm(uv+u_turb*q+vec2(1.7,9.2)+t*0.15),
                  fbm(uv+u_turb*q+vec2(8.3,2.8)+t*0.12));
      float f=fbm(uv+u_turb*r+t*0.1);
      float orbs=0.0;
      for(float i=0.0;i<6.0;i++){
        if(i>=u_orbs) break;
        float fi=i/max(u_orbs-1.0,1.0);
        float angle=fi*6.2832+t*(0.3+fi*0.2);
        float radius=0.25+fi*0.18;
        vec2 center=vec2(0.5*u_res.x/u_res.y+cos(angle)*radius,0.5+sin(angle)*radius*0.7);
        float dist=length(uv-center);
        float pulse=1.0+0.12*sin(t*u_pulse*6.2832+fi*2.094);
        orbs+=(0.06*pulse)/(dist+0.001);
      }
      vec3 col=mix(u_c0,u_c1,clamp(f*f*f*2.5+orbs*0.3,0.0,1.0));
      col=mix(col,u_c2,clamp(length(q)*0.5+orbs*0.15,0.0,1.0));
      float pulse=1.0+0.06*sin(t*u_pulse*6.2832);
      col*=u_bright*pulse;
      vec2 vig=uv-vec2(0.5*u_res.x/u_res.y,0.5);
      col*=1.0-dot(vig,vig)*0.6;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // ── WebGL init ─────────────────────────────────────────────
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); return s;
  }

  function initGL() {
    canvas = document.getElementById('ambient-canvas');
    if (!canvas) return false;
    gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.linkProgram(program); gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['u_time','u_res','u_c0','u_c1','u_c2','u_speed','u_turb','u_pulse','u_orbs','u_bright']
      .forEach(n => uniforms[n] = gl.getUniformLocation(program, n));
    return true;
  }

  function resize() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // ── Render loop ────────────────────────────────────────────
  function lerp(a,b,t){return a+(b-a)*t;}
  function lerpColor(a,b,t){return a.map((v,i)=>lerp(v,b[i],t));}
  function lerpPalette(a,b,t){
    return {
      colors: a.colors.map((c,i)=>lerpColor(c,b.colors[i],t)),
      speed:      lerp(a.speed,b.speed,t),
      turbulence: lerp(a.turbulence,b.turbulence,t),
      pulseRate:  lerp(a.pulseRate,b.pulseRate,t),
      orbCount:   lerp(a.orbCount,b.orbCount,t),
      brightness: lerp(a.brightness,b.brightness,t),
    };
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!gl) return;
    if (targetPalette && lerpT < 1) {
      lerpT = Math.min(lerpT + 0.004, 1);
      currentPalette = lerpPalette(currentPalette, targetPalette, lerpT);
    }
    const p = currentPalette || DEFAULT;
    const t = (Date.now() - startTime) / 1000;
    gl.uniform1f(uniforms.u_time,   t);
    gl.uniform2f(uniforms.u_res,    canvas.width, canvas.height);
    gl.uniform3fv(uniforms.u_c0,    p.colors[0]);
    gl.uniform3fv(uniforms.u_c1,    p.colors[1]);
    gl.uniform3fv(uniforms.u_c2,    p.colors[2]);
    gl.uniform1f(uniforms.u_speed,  p.speed);
    gl.uniform1f(uniforms.u_turb,   p.turbulence);
    gl.uniform1f(uniforms.u_pulse,  p.pulseRate);
    gl.uniform1f(uniforms.u_orbs,   p.orbCount);
    gl.uniform1f(uniforms.u_bright, p.brightness);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── Public API ─────────────────────────────────────────────
  function init() {
    if (!initGL()) { console.warn('[Ambient] WebGL unavailable'); return; }
    currentPalette = JSON.parse(JSON.stringify(DEFAULT));
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(draw);
  }

  async function setSong(songName, artistName, authToken) {
    // Instant hash palette — something shifts immediately
    targetPalette = hashPalette(songName, artistName);
    lerpT = 0;

    // Then upgrade with real Last.fm mood tags
    try {
      const res = await fetch(
        `https://onesong.onrender.com/mood?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`,
        { headers: { 'Authorization': `Bearer ${authToken}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const moodPalette = tagsToMood(data.tags);
      if (moodPalette) {
        targetPalette = moodPalette;
        lerpT = 0;
        console.log('[Ambient] Mood from tags:', data.tags.slice(0,5).join(', '));
      }
    } catch (e) {
      console.warn('[Ambient] Tag fetch failed, using hash palette');
    }
  }

  function reset() {
    targetPalette = JSON.parse(JSON.stringify(DEFAULT));
    lerpT = 0;
  }

  return { init, setSong, reset };
})();