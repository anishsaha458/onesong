// ─────────────────────────────────────────────────────────────
// AMBIENT ENGINE v3 — BPM-synced, mood-driven visual system
//
// BPM resolution pipeline (4 layers):
//   1. AcousticBrainz archive  → exact BPM
//   2. Last.fm tag BPM hints   → "120bpm", "fast", "slow"
//   3. Genre/mood BPM estimate → techno≈130, ballad≈70
//   4. Default pulse           → 80 BPM, always looks good
//
// The beat drives a real-time "kick" uniform in the shader,
// causing the whole fluid to surge and bloom on every beat.
// ─────────────────────────────────────────────────────────────

const Ambient = (() => {

  let canvas, gl, program;
  let startTime = Date.now();
  let uniforms  = {};
  let currentPalette = null;
  let targetPalette  = null;
  let lerpT = 1;

  // Beat state
  let bpm         = 80;
  let beatTimer   = null;
  let kickValue   = 0;      // 0→1, decays each frame
  let kickDecay   = 0.92;   // how fast the beat flash fades

  const DEFAULT = {
    colors:     [[0.08,0.06,0.12],[0.14,0.10,0.22],[0.06,0.08,0.16]],
    speed:      0.18,
    turbulence: 0.55,
    pulseRate:  0.6,
    orbCount:   3.0,
    brightness: 0.55,
  };

  // ── GENRE/MOOD → BPM ESTIMATES (Layer 3 fallback) ─────────
  const GENRE_BPM = [
    { keys: ['drum and bass','dnb','jungle'],          bpm: 170 },
    { keys: ['hardstyle','hardcore','gabber'],          bpm: 160 },
    { keys: ['techno','hard techno'],                   bpm: 140 },
    { keys: ['trance','psytrance','uplifting trance'],  bpm: 138 },
    { keys: ['house','electro house','tech house'],     bpm: 128 },
    { keys: ['edm','electronic dance','dance'],         bpm: 128 },
    { keys: ['dubstep'],                                bpm: 140 },
    { keys: ['disco','funk'],                           bpm: 118 },
    { keys: ['hip hop','hiphop','hip-hop','trap'],      bpm: 90  },
    { keys: ['rap'],                                    bpm: 88  },
    { keys: ['reggaeton','latin'],                      bpm: 95  },
    { keys: ['punk','hardcore punk'],                   bpm: 160 },
    { keys: ['metal','heavy metal','death metal'],      bpm: 150 },
    { keys: ['rock','hard rock','alternative rock'],    bpm: 120 },
    { keys: ['indie rock','indie pop'],                 bpm: 115 },
    { keys: ['pop'],                                    bpm: 118 },
    { keys: ['r&b','rnb','soul'],                       bpm: 90  },
    { keys: ['jazz'],                                   bpm: 120 },
    { keys: ['blues'],                                  bpm: 80  },
    { keys: ['classical','orchestral','symphony'],      bpm: 72  },
    { keys: ['ambient','drone','experimental'],         bpm: 60  },
    { keys: ['folk','acoustic','country','americana'],  bpm: 88  },
    { keys: ['reggae','dub'],                           bpm: 80  },
    { keys: ['ballad','sad','slow','melancholic'],      bpm: 68  },
    { keys: ['chill','chillout','lo-fi','lofi'],        bpm: 75  },
    { keys: ['energetic','energy','upbeat','fast'],     bpm: 130 },
  ];

  // ── TAG → MOOD RULES ──────────────────────────────────────
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

  // ── BPM extraction helpers ─────────────────────────────────

  // Layer 2: scan Last.fm tags for explicit BPM mentions
  function bpmFromTags(tags) {
    if (!tags || !tags.length) return null;

    // Look for explicit numeric BPM tags like "120bpm", "120 bpm", "bpm120"
    for (const tag of tags) {
      const m = tag.match(/(\d{2,3})\s*bpm/i) || tag.match(/bpm\s*(\d{2,3})/i);
      if (m) {
        const val = parseInt(m[1]);
        if (val >= 40 && val <= 220) return val;
      }
    }

    // Text tempo descriptors
    const tempoMap = [
      { keys: ['very fast','blazing','breakneck'],      bpm: 180 },
      { keys: ['fast','uptempo','up-tempo','speedy'],    bpm: 140 },
      { keys: ['moderate','mid-tempo','midtempo'],       bpm: 100 },
      { keys: ['slow','downtempo','down-tempo'],         bpm: 70  },
      { keys: ['very slow','glacial','drone'],           bpm: 55  },
    ];
    for (const { keys, bpm } of tempoMap) {
      if (keys.some(k => tags.some(t => t.includes(k)))) return bpm;
    }
    return null;
  }

  // Layer 3: estimate BPM from genre/mood tags
  function bpmFromGenre(tags) {
    if (!tags || !tags.length) return null;
    for (const { keys, bpm } of GENRE_BPM) {
      if (keys.some(k => tags.some(t => t.includes(k) || k.includes(t)))) return bpm;
    }
    return null;
  }

  // Layer 1.5: BPM from song title + artist name
  // Catches classical markings, dance forms, and tempo words
  // before falling through to genre tags.
  const TITLE_BPM = [
    // Classical tempo markings (Italian)
    { keys: ['grave','larghissimo'],                      bpm: 40  },
    { keys: ['largo','lento','adagissimo'],               bpm: 50  },
    { keys: ['adagio'],                                   bpm: 60  },
    { keys: ['adagietto','andante'],                      bpm: 72  },
    { keys: ['andantino','moderato'],                     bpm: 88  },
    { keys: ['allegretto'],                               bpm: 108 },
    { keys: ['allegro'],                                  bpm: 128 },
    { keys: ['vivace','vivacissimo'],                     bpm: 156 },
    { keys: ['presto'],                                   bpm: 168 },
    { keys: ['prestissimo'],                              bpm: 188 },
    // Dance forms
    { keys: ['waltz','valse','vals'],                     bpm: 90  },
    { keys: ['mazurka'],                                  bpm: 112 },
    { keys: ['polka'],                                    bpm: 120 },
    { keys: ['minuet','menuet'],                          bpm: 126 },
    { keys: ['march','marche','marcia'],                  bpm: 120 },
    { keys: ['gavotte'],                                  bpm: 118 },
    { keys: ['gigue','jig'],                              bpm: 160 },
    { keys: ['bolero'],                                   bpm: 72  },
    { keys: ['tango'],                                    bpm: 60  },
    { keys: ['samba'],                                    bpm: 100 },
    { keys: ['bossa nova','bossanova'],                   bpm: 130 },
    { keys: ['rumba'],                                    bpm: 108 },
    { keys: ['cha cha','cha-cha'],                        bpm: 120 },
    { keys: ['foxtrot'],                                  bpm: 120 },
    { keys: ['quickstep'],                                bpm: 200 },
    // Common English tempo words in titles
    { keys: ['lullaby','cradle','berceuse','nocturne'],   bpm: 56  },
    { keys: ['hymn','chorale','prayer','requiem'],        bpm: 60  },
    { keys: ['elegy','funeral','dirge'],                  bpm: 52  },
    { keys: ['serenade'],                                 bpm: 76  },
    { keys: ['intermezzo'],                               bpm: 88  },
    { keys: ['scherzo'],                                  bpm: 152 },
    { keys: ['rondo','tarantella'],                       bpm: 168 },
    { keys: ['barcarolle'],                               bpm: 66  },
    { keys: ['caprice','capriccio'],                      bpm: 144 },
    { keys: ['etude','étude','prelude','prélude'],        bpm: 100 },
    { keys: ['fantasia','fantasy','impromptu'],           bpm: 96  },
    { keys: ['rhapsody'],                                 bpm: 108 },
    // Modern tempo words that appear in titles
    { keys: ['slow jam','slow burn'],                     bpm: 65  },
    { keys: ['hypersonic','lightning','rocket','blitz'],  bpm: 180 },
    { keys: ['crawl','creep','drift','float'],            bpm: 58  },
    { keys: ['gallop','sprint','dash','rush'],            bpm: 160 },
    { keys: ['groove','bounce','bop','swing'],            bpm: 100 },
  ];

  function bpmFromTitle(songName, artistName) {
    const text = (songName + ' ' + artistName).toLowerCase();
    for (const { keys, bpm } of TITLE_BPM) {
      // Use word-boundary-aware check so "largo" doesn't match "enlarge"
      if (keys.some(k => {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|[\\s\\-_(,])${escaped}(?:[\\s\\-_),]|$)`).test(text);
      })) return bpm;
    }
    return null;
  }

  // ── Beat clock ─────────────────────────────────────────────
  function setBPM(newBpm) {
    bpm = Math.max(40, Math.min(220, newBpm));
    if (beatTimer) clearInterval(beatTimer);
    const interval = (60 / bpm) * 1000; // ms per beat
    beatTimer = setInterval(() => {
      kickValue = 1.0; // full kick on beat
    }, interval);
    console.log(`[Ambient] BPM set to ${bpm} (${Math.round(interval)}ms/beat)`);
  }

  // ── Palette helpers ────────────────────────────────────────
  function tagsToMood(tags) {
    if (!tags || !tags.length) return null;
    const matched = [];
    for (const rule of MOOD_RULES) {
      const hits = rule.keys.filter(k => tags.some(t => t.includes(k) || k.includes(t)));
      if (hits.length > 0) matched.push({ palette: rule.palette, weight: hits.length });
    }
    if (!matched.length) return null;

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

  function hashPalette(songName, artistName) {
    const str = (songName + artistName).toLowerCase();
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    const rand = s => { let x = Math.sin(s + h) * 43758.5453; return x - Math.floor(x); };
    const hue = rand(1) * 360;
    const hsl2rgb = (h, s, l) => {
      h /= 360; s /= 100; l /= 100;
      const a = s * Math.min(l, 1 - l);
      const f = n => { const k = (n + h*12)%12; return l - a*Math.max(-1,Math.min(k-3,9-k,1)); };
      return [f(0), f(8), f(4)];
    };
    return {
      colors: [hsl2rgb(hue,40,12), hsl2rgb(hue+30,45,18), hsl2rgb(hue-20,35,10)],
      speed:      0.12 + rand(2)*0.15,
      turbulence: 0.40 + rand(3)*0.50,
      pulseRate:  0.40 + rand(4)*0.80,
      orbCount:   2 + Math.round(rand(5)*3),
      brightness: 0.45 + rand(6)*0.25,
    };
  }

  // ── GLSL — kick uniform drives beat bloom ─────────────────
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
    uniform float u_kick;   // 0→1, beat impulse

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

      // Beat distorts the UV space — fluid lurches on kick
      float kickPush = u_kick * 0.018;
      vec2 center = vec2(0.5*u_res.x/u_res.y, 0.5);
      vec2 toCenter = normalize(uv - center);
      float distToCenter = length(uv - center);
      uv += toCenter * kickPush * (1.0 - smoothstep(0.0, 0.8, distToCenter));

      float t=u_time*u_speed;
      vec2 q=vec2(fbm(uv+t*0.4), fbm(uv+vec2(5.2,1.3)));
      vec2 r=vec2(fbm(uv+u_turb*q+vec2(1.7,9.2)+t*0.15),
                  fbm(uv+u_turb*q+vec2(8.3,2.8)+t*0.12));
      float f=fbm(uv+u_turb*r+t*0.1);

      float orbs=0.0;
      for(float i=0.0;i<6.0;i++){
        if(i>=u_orbs) break;
        float fi=i/max(u_orbs-1.0,1.0);
        float angle=fi*6.2832+t*(0.3+fi*0.2);
        // Orbs expand outward on kick
        float radius=(0.25+fi*0.18)*(1.0+u_kick*0.15);
        vec2 oc=vec2(0.5*u_res.x/u_res.y+cos(angle)*radius, 0.5+sin(angle)*radius*0.7);
        float dist=length(uv-oc);
        float pulse=1.0+0.12*sin(t*u_pulse*6.2832+fi*2.094);
        orbs+=(0.06*pulse*(1.0+u_kick*0.8))/(dist+0.001);
      }

      vec3 col=mix(u_c0,u_c1,clamp(f*f*f*2.5+orbs*0.3,0.0,1.0));
      col=mix(col,u_c2,clamp(length(q)*0.5+orbs*0.15,0.0,1.0));

      // Beat flash: brief brightness surge + slight hue push toward white
      float beatFlash = u_kick * 0.35;
      col = col + beatFlash * (vec3(1.0,1.0,1.0) - col) * 0.4;
      col *= (u_bright + u_kick * 0.20);

      vec2 vig=uv-vec2(0.5*u_res.x/u_res.y,0.5);
      col*=1.0-dot(vig,vig)*(0.6 - u_kick*0.15);

      gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
    }
  `;

  // ── WebGL init ─────────────────────────────────────────────
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error('[Ambient] Shader:', gl.getShaderInfoLog(s));
    return s;
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
    ['u_time','u_res','u_c0','u_c1','u_c2',
     'u_speed','u_turb','u_pulse','u_orbs','u_bright','u_kick']
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
      speed:      lerp(a.speed,      b.speed,      t),
      turbulence: lerp(a.turbulence, b.turbulence, t),
      pulseRate:  lerp(a.pulseRate,  b.pulseRate,  t),
      orbCount:   lerp(a.orbCount,   b.orbCount,   t),
      brightness: lerp(a.brightness, b.brightness, t),
    };
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!gl) return;

    // Palette transition
    if (targetPalette && lerpT < 1) {
      lerpT = Math.min(lerpT + 0.004, 1);
      currentPalette = lerpPalette(currentPalette, targetPalette, lerpT);
    }

    // Decay kick each frame
    kickValue *= kickDecay;

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
    gl.uniform1f(uniforms.u_kick,   kickValue);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── Public API ─────────────────────────────────────────────
  function init() {
    if (!initGL()) {
      console.warn('[Ambient] WebGL unavailable — falling back to CSS gradient');
      // Fallback: animated CSS gradient so something always shows
      document.body.style.background = `
        radial-gradient(ellipse at 20% 30%, rgba(80,40,120,0.6) 0%, transparent 60%),
        radial-gradient(ellipse at 80% 70%, rgba(40,60,120,0.5) 0%, transparent 60%),
        #0d0d0f
      `;
      return;
    }
    currentPalette = JSON.parse(JSON.stringify(DEFAULT));
    setBPM(80);
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(draw);
    console.log('[Ambient] WebGL canvas running ✓');
  }

  async function setSong(songName, artistName, authToken) {
    // Layer 4 default
    let resolvedBpm = 80;

    // Instant hash palette
    targetPalette = hashPalette(songName, artistName);
    lerpT = 0;

    try {
      // Fetch mood tags + BPM from backend in one call
      const res = await fetch(
        `https://onesong.onrender.com/bpm?track=${encodeURIComponent(songName)}&artist=${encodeURIComponent(artistName)}`,
        { headers: { 'Authorization': `Bearer ${authToken}` } }
      );
      if (res.ok) {
        const data = await res.json();
        const tags = data.tags || [];

        // Upgrade palette from mood tags
        const moodPalette = tagsToMood(tags);
        if (moodPalette) {
          targetPalette = moodPalette;
          lerpT = 0;
        }

        // Layer 1: exact BPM from AcousticBrainz
        if (data.bpm && data.bpm > 0) {
          resolvedBpm = data.bpm;
          console.log(`[Ambient] BPM from AcousticBrainz: ${resolvedBpm}`);
        }
        // Layer 1.5: BPM from song title / artist name
        else if (bpmFromTitle(songName, artistName)) {
          resolvedBpm = bpmFromTitle(songName, artistName);
          console.log(`[Ambient] BPM from title: ${resolvedBpm}`);
        }
        // Layer 2: BPM from tag text
        else if (bpmFromTags(tags)) {
          resolvedBpm = bpmFromTags(tags);
          console.log(`[Ambient] BPM from tags: ${resolvedBpm}`);
        }
        // Layer 3: BPM from genre
        else if (bpmFromGenre(tags)) {
          resolvedBpm = bpmFromGenre(tags);
          console.log(`[Ambient] BPM from genre: ${resolvedBpm}`);
        }
        // Layer 4: hash-based BPM from title length/chars for a unique feel
        else {
          const titleHash = songName.split('').reduce((h,c) => Math.imul(31,h) + c.charCodeAt(0)|0, 0);
          const hashBpm = 60 + Math.abs(titleHash % 80); // range 60–140
          resolvedBpm = hashBpm;
          console.log(`[Ambient] BPM from hash: ${resolvedBpm}`);
        }
      }
    } catch(e) {
      console.warn('[Ambient] BPM/mood fetch failed, using title/hash fallback', e);
      // Still try title-based BPM even without network
      const titleBpm = bpmFromTitle(songName, artistName);
      if (titleBpm) {
        resolvedBpm = titleBpm;
        console.log(`[Ambient] BPM from title (offline): ${resolvedBpm}`);
      } else {
        const titleHash = songName.split('').reduce((h,c) => Math.imul(31,h) + c.charCodeAt(0)|0, 0);
        resolvedBpm = 60 + Math.abs(titleHash % 80);
      }
    }

    setBPM(resolvedBpm);
  }

  function reset() {
    targetPalette = JSON.parse(JSON.stringify(DEFAULT));
    lerpT = 0;
    setBPM(80);
  }

  return { init, setSong, reset };

})();