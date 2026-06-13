const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2');
const vs = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs, `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`);
gl.compileShader(vs);
if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) console.error('vs: ' + gl.getShaderInfoLog(vs));
const fs = gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs, `#version 300 es
precision mediump float; out vec4 c; void main(){ c = vec4(1.,0.5,0.,1.); }`);
gl.compileShader(fs);
if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) console.error('fs: ' + gl.getShaderInfoLog(fs));
const prog = gl.createProgram();
gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error('link failed');
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8,-0.8, 0.8,-0.8, 0,0.9]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'p');
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, 0, 0, 0);
console.log('gl setup done, err=' + gl.getError());
function loop() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);  // screen = frontend default FBO
  gl.viewport(0, 0, 640, 480);
  gl.clearColor(0.1, 0.1, 0.2, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
