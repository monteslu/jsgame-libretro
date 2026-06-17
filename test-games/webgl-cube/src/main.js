// webgl-cube — self-contained WebGL2: a spinning, lit 3D cube. No engine.
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2');
const W = canvas.width, H = canvas.height;

function sh(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
in vec3 pos; in vec3 nrm; uniform mat4 mvp; uniform mat4 model;
out vec3 vN; out vec3 vP;
void main(){ gl_Position = mvp*vec4(pos,1.0); vN = mat3(model)*nrm; vP = pos; }`));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; in vec3 vN; in vec3 vP; out vec4 col;
void main(){
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(0.6,0.8,1.0));
  float d = max(dot(n,L),0.0);
  vec3 base = vP*0.5+0.5;          // position-tinted faces
  col = vec4(base*(0.3+0.7*d), 1.0);
}`));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error('link: ' + gl.getProgramInfoLog(prog));

// cube: 24 verts (pos+normal), 36 indices
const v = [];
const faces = [
  [[ 0, 0, 1],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
  [[ 0, 0,-1],[[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
  [[ 0, 1, 0],[[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],
  [[ 0,-1, 0],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]],
  [[ 1, 0, 0],[[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],
  [[-1, 0, 0],[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],
];
const idx = [];
faces.forEach((f, fi) => {
  const [n, q] = f;
  q.forEach((p) => v.push(p[0], p[1], p[2], n[0], n[1], n[2]));
  const b = fi*4;
  idx.push(b, b+1, b+2, b, b+2, b+3);
});
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
const ebo = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
const pl = gl.getAttribLocation(prog, 'pos');
gl.enableVertexAttribArray(pl);
gl.vertexAttribPointer(pl, 3, gl.FLOAT, false, 24, 0);
const nl = gl.getAttribLocation(prog, 'nrm');
gl.enableVertexAttribArray(nl);
gl.vertexAttribPointer(nl, 3, gl.FLOAT, false, 24, 12);
const mvpLoc = gl.getUniformLocation(prog, 'mvp');
const modelLoc = gl.getUniformLocation(prog, 'model');
gl.enable(gl.DEPTH_TEST);

// minimal mat4 (column-major)
function mul(a, b){ const o = new Float32Array(16);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o; }
function persp(f, asp, n, fa){ const t=1/Math.tan(f/2); return new Float32Array([t/asp,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]); }
function rotY(a){ const c=Math.cos(a),s=Math.sin(a); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); }
function rotX(a){ const c=Math.cos(a),s=Math.sin(a); return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); }
function trans(x,y,z){ return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]); }

let t = 0;
function frame() {
  t += 0.02;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0.07, 0.07, 0.12, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  const model = mul(rotY(t), rotX(t*0.7));
  const view = trans(0, 0, -5);
  const proj = persp(1.0, W/H, 0.1, 100);
  const mvp = mul(proj, mul(view, model));
  gl.uniformMatrix4fv(mvpLoc, false, mvp);
  gl.uniformMatrix4fv(modelLoc, false, model);
  gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
  requestAnimationFrame(frame);
}
console.log('webgl-cube booted');
requestAnimationFrame(frame);
