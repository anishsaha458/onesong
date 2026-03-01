// ==========================================
// CONFIGURATION & STATE
// ==========================================
const canvas = document.getElementById('bg-canvas');
const gl = canvas.getContext('webgl');

let time = 0;

// Beat state
let kickValue = 0;      
let kickDecay = 0.96; // Smooth ripple decay

// Mouse state
let mouseX = 0.5, mouseY = 0.5;
let targetMouseX = 0.5, targetMouseY = 0.5;

// Default uniforms for the fluid appearance
const config = {
    speed: 0.2,
    turb: 1.5,
    pulse: 1.0,
    orbs: 3.0,
    bright: 1.2
};

// Colors: [Base, Highlight, Shadow] (RGB values 0.0 to 1.0)
let currentPalette = [
    [0.05, 0.05, 0.1], // Dark blue
    [0.2, 0.5, 0.9],   // Bright blue
    [0.01, 0.01, 0.05] // Deep navy
];
let targetPalette = [...currentPalette];

// ==========================================
// PALETTE & MOOD LOGIC
// ==========================================
const MOOD_RULES = {
    "sad": [[0.05, 0.05, 0.15], [0.2, 0.3, 0.6], [0.0, 0.0, 0.05]],
    "happy": [[0.8, 0.3, 0.1], [1.0, 0.8, 0.2], [0.4, 0.0, 0.1]],
    "chill": [[0.1, 0.2, 0.15], [0.4, 0.8, 0.6], [0.05, 0.1, 0.05]],
    "electronic": [[0.1, 0.0, 0.2], [0.9, 0.2, 1.0], [0.0, 0.0, 0.1]]
};

// Fallback: Generates a unique 3-color palette from a text string (like song title)
function hashPalette(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash % 360) / 360;
    
    // Quick helper to convert HSL to RGB for WebGL
    const hsl2rgb = (h, s, l) => {
        let r, g, b;
        if (s === 0) r = g = b = l; else {
            const hue2rgb = (p, q, t) => {
                if(t < 0) t += 1; if(t > 1) t -= 1;
                if(t < 1/6) return p + (q - p) * 6 * t;
                if(t < 1/2) return q;
                if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }
        return [r, g, b];
    };

    return [
        hsl2rgb(hue, 0.8, 0.15), // Base
        hsl2rgb((hue + 0.1) % 1.0, 0.9, 0.6), // Highlight
        hsl2rgb((hue - 0.1 + 1.0) % 1.0, 1.0, 0.05) // Shadow
    ];
}

// Smoothly transition current colors to target colors
function lerpPalette() {
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            currentPalette[i][j] += (targetPalette[i][j] - currentPalette[i][j]) * 0.02;
        }
    }
}

// Simulate fetching a new song
function loadSongVisuals(songTitle, tags) {
    let found = false;
    for (let tag of tags) {
        if (MOOD_RULES[tag]) {
            targetPalette = MOOD_RULES[tag];
            found = true;
            break;
        }
    }
    if (!found) targetPalette = hashPalette(songTitle);
}

// ==========================================
// SHADERS
// ==========================================
const VERT = `
    attribute vec2 position;
    void main() {
        gl_Position = vec4(position, 0.0, 1.0);
    }
`;

const FRAG = `
    precision highp float;
    uniform float u_time;
    uniform vec2  u_res;
    uniform vec3  u_c0, u_c1, u_c2;
    uniform float u_speed, u_turb, u_pulse, u_orbs, u_bright;
    uniform float u_kick;
    uniform vec2  u_mouse;

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
      vec2 center = vec2(0.5*u_res.x/u_res.y, 0.5);
      vec2 toCenter = normalize(uv - center);
      float distToCenter = length(uv - center);

      // --- SMOOTH RIPPLE MATH ---
      float rippleRadius = (1.0 - u_kick) * 1.5;
      float ring = smoothstep(rippleRadius - 0.3, rippleRadius, distToCenter) - 
                   smoothstep(rippleRadius, rippleRadius + 0.1, distToCenter);
      float rippleIntensity = ring * u_kick;
      
      uv += toCenter * rippleIntensity * 0.04;

      // --- MOUSE INTERACTION MATH ---
      vec2 mouseUv = vec2(u_mouse.x * u_res.x/u_res.y, u_mouse.y);
      vec2 toMouse = uv - mouseUv;
      float distToMouse = length(toMouse);
      
      float mouseInfluence = smoothstep(0.4, 0.0, distToMouse); 
      uv += normalize(toMouse) * mouseInfluence * 0.08;

      // --- FLUID GENERATION ---
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
        
        float radius=(0.25+fi*0.18)*(1.0 + rippleIntensity*0.15); 
        vec2 oc=vec2(0.5*u_res.x/u_res.y+cos(angle)*radius, 0.5+sin(angle)*radius*0.7);
        float dist=length(uv-oc);
        float pulse=1.0+0.12*sin(t*u_pulse*6.2832+fi*2.094);
        orbs+=(0.06*pulse)/(dist+0.001);
      }

      vec3 col=mix(u_c0,u_c1,clamp(f*f*f*2.5+orbs*0.3,0.0,1.0));
      col=mix(col,u_c2,clamp(length(q)*0.5+orbs*0.15,0.0,1.0));

      // Add a soft, colorful glow to the ripple wave
      col += u_c1 * rippleIntensity * 0.5;
      col *= u_bright;

      // Static vignette
      vec2 vig=uv-vec2(0.5*u_res.x/u_res.y,0.5);
      col*=1.0-dot(vig,vig)*0.6;

      gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
    }
`;

// ==========================================
// WEBGL SETUP & RENDER LOOP
// ==========================================
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

const vertexShader = compileShader(gl.VERTEX_SHADER, VERT);
const fragmentShader = compileShader(gl.FRAGMENT_SHADER, FRAG);
const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
gl.useProgram(program);

const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

const positionLocation = gl.getAttribLocation(program, "position");
gl.enableVertexAttribArray(positionLocation);
gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

const locs = {
    time: gl.getUniformLocation(program, "u_time"),
    res: gl.getUniformLocation(program, "u_res"),
    c0: gl.getUniformLocation(program, "u_c0"),
    c1: gl.getUniformLocation(program, "u_c1"),
    c2: gl.getUniformLocation(program, "u_c2"),
    speed: gl.getUniformLocation(program, "u_speed"),
    turb: gl.getUniformLocation(program, "u_turb"),
    pulse: gl.getUniformLocation(program, "u_pulse"),
    orbs: gl.getUniformLocation(program, "u_orbs"),
    bright: gl.getUniformLocation(program, "u_bright"),
    kick: gl.getUniformLocation(program, "u_kick"),
    mouse: gl.getUniformLocation(program, "u_mouse")
};

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize);
resize();

// ==========================================
// INTERACTION EVENTS
// ==========================================
window.addEventListener('mousemove', (e) => {
    targetMouseX = e.clientX / window.innerWidth;
    targetMouseY = 1.0 - (e.clientY / window.innerHeight); 
});

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        kickValue = 1.0; 
        
        // Bonus: Randomly change the palette to a new hashed string on beat
        // loadSongVisuals(Math.random().toString(), []); 
    }
});

// ==========================================
// MAIN RENDER LOOP
// ==========================================
function render() {
    time += 0.01;
    
    // Process beat decay
    kickValue *= kickDecay; 
    if (kickValue < 0.001) kickValue = 0;

    // Process mouse smoothing
    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    // Process color transitions
    lerpPalette(); 

    // Send data to WebGL
    gl.uniform1f(locs.time, time);
    gl.uniform2f(locs.res, canvas.width, canvas.height);
    gl.uniform3fv(locs.c0, currentPalette[0]);
    gl.uniform3fv(locs.c1, currentPalette[1]);
    gl.uniform3fv(locs.c2, currentPalette[2]);
    
    gl.uniform1f(locs.speed, config.speed);
    gl.uniform1f(locs.turb, config.turb);
    gl.uniform1f(locs.pulse, config.pulse);
    gl.uniform1f(locs.orbs, config.orbs);
    gl.uniform1f(locs.bright, config.bright);
    
    gl.uniform1f(locs.kick, kickValue);
    gl.uniform2f(locs.mouse, mouseX, mouseY);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
}

// Start the loop
render();