#pragma once
#include <napi.h>

namespace gl {
    // State
    Napi::Value _enable(const Napi::CallbackInfo& info);
    Napi::Value _disable(const Napi::CallbackInfo& info);
    Napi::Value _getError(const Napi::CallbackInfo& info);
    Napi::Value _getIntegerv(const Napi::CallbackInfo& info);
    Napi::Value _getString(const Napi::CallbackInfo& info);
    void _finish(const Napi::CallbackInfo& info);
    void _flush(const Napi::CallbackInfo& info);
    void _hint(const Napi::CallbackInfo& info);
    void _pixelStorei(const Napi::CallbackInfo& info);

    // Viewport/Clear
    void _viewport(const Napi::CallbackInfo& info);
    void _scissor(const Napi::CallbackInfo& info);
    void _clear(const Napi::CallbackInfo& info);
    void _clearColor(const Napi::CallbackInfo& info);
    void _clearDepthf(const Napi::CallbackInfo& info);
    void _clearStencil(const Napi::CallbackInfo& info);

    // Blending
    void _blendFunc(const Napi::CallbackInfo& info);
    void _blendFuncSeparate(const Napi::CallbackInfo& info);
    void _blendEquation(const Napi::CallbackInfo& info);
    void _blendEquationSeparate(const Napi::CallbackInfo& info);
    void _blendColor(const Napi::CallbackInfo& info);
    void _colorMask(const Napi::CallbackInfo& info);

    // Depth/Stencil
    void _depthFunc(const Napi::CallbackInfo& info);
    void _depthMask(const Napi::CallbackInfo& info);
    void _depthRangef(const Napi::CallbackInfo& info);
    void _stencilFunc(const Napi::CallbackInfo& info);
    void _stencilFuncSeparate(const Napi::CallbackInfo& info);
    void _stencilOp(const Napi::CallbackInfo& info);
    void _stencilOpSeparate(const Napi::CallbackInfo& info);
    void _stencilMask(const Napi::CallbackInfo& info);
    void _stencilMaskSeparate(const Napi::CallbackInfo& info);

    // Face culling
    void _cullFace(const Napi::CallbackInfo& info);
    void _frontFace(const Napi::CallbackInfo& info);
    void _polygonOffset(const Napi::CallbackInfo& info);
    void _lineWidth(const Napi::CallbackInfo& info);

    // Buffers
    void _genBuffers(const Napi::CallbackInfo& info);
    void _deleteBuffers(const Napi::CallbackInfo& info);
    void _bindBuffer(const Napi::CallbackInfo& info);
    void _bufferData(const Napi::CallbackInfo& info);
    void _bufferSubData(const Napi::CallbackInfo& info);

    // Textures
    void _genTextures(const Napi::CallbackInfo& info);
    void _deleteTextures(const Napi::CallbackInfo& info);
    void _bindTexture(const Napi::CallbackInfo& info);
    void _activeTexture(const Napi::CallbackInfo& info);
    void _texImage2D(const Napi::CallbackInfo& info);
    void _texSubImage2D(const Napi::CallbackInfo& info);
    void _texParameteri(const Napi::CallbackInfo& info);
    void _texParameterf(const Napi::CallbackInfo& info);
    void _generateMipmap(const Napi::CallbackInfo& info);
    void _compressedTexImage2D(const Napi::CallbackInfo& info);

    // Shaders
    Napi::Value _createShader(const Napi::CallbackInfo& info);
    void _deleteShader(const Napi::CallbackInfo& info);
    void _shaderSource(const Napi::CallbackInfo& info);
    void _compileShader(const Napi::CallbackInfo& info);
    Napi::Value _getShaderiv(const Napi::CallbackInfo& info);
    Napi::Value _getShaderInfoLog(const Napi::CallbackInfo& info);

    // Programs
    Napi::Value _createProgram(const Napi::CallbackInfo& info);
    void _deleteProgram(const Napi::CallbackInfo& info);
    void _attachShader(const Napi::CallbackInfo& info);
    void _detachShader(const Napi::CallbackInfo& info);
    void _linkProgram(const Napi::CallbackInfo& info);
    void _useProgram(const Napi::CallbackInfo& info);
    Napi::Value _getProgramiv(const Napi::CallbackInfo& info);
    Napi::Value _getProgramInfoLog(const Napi::CallbackInfo& info);
    void _validateProgram(const Napi::CallbackInfo& info);
    void _bindAttribLocation(const Napi::CallbackInfo& info);
    Napi::Value _getAttribLocation(const Napi::CallbackInfo& info);
    Napi::Value _getUniformLocation(const Napi::CallbackInfo& info);

    // Uniforms
    void _uniform1i(const Napi::CallbackInfo& info);
    void _uniform2i(const Napi::CallbackInfo& info);
    void _uniform3i(const Napi::CallbackInfo& info);
    void _uniform4i(const Napi::CallbackInfo& info);
    void _uniform1f(const Napi::CallbackInfo& info);
    void _uniform2f(const Napi::CallbackInfo& info);
    void _uniform3f(const Napi::CallbackInfo& info);
    void _uniform4f(const Napi::CallbackInfo& info);
    void _uniform1iv(const Napi::CallbackInfo& info);
    void _uniform2iv(const Napi::CallbackInfo& info);
    void _uniform3iv(const Napi::CallbackInfo& info);
    void _uniform4iv(const Napi::CallbackInfo& info);
    void _uniform1fv(const Napi::CallbackInfo& info);
    void _uniform2fv(const Napi::CallbackInfo& info);
    void _uniform3fv(const Napi::CallbackInfo& info);
    void _uniform4fv(const Napi::CallbackInfo& info);
    void _uniformMatrix2fv(const Napi::CallbackInfo& info);
    void _uniformMatrix3fv(const Napi::CallbackInfo& info);
    void _uniformMatrix4fv(const Napi::CallbackInfo& info);

    // Vertex attribs
    void _enableVertexAttribArray(const Napi::CallbackInfo& info);
    void _disableVertexAttribArray(const Napi::CallbackInfo& info);
    void _vertexAttribPointer(const Napi::CallbackInfo& info);

    // Drawing
    void _drawArrays(const Napi::CallbackInfo& info);
    void _drawElements(const Napi::CallbackInfo& info);

    // FBOs
    void _genFramebuffers(const Napi::CallbackInfo& info);
    void _deleteFramebuffers(const Napi::CallbackInfo& info);
    void _bindFramebuffer(const Napi::CallbackInfo& info);
    Napi::Value _checkFramebufferStatus(const Napi::CallbackInfo& info);
    void _framebufferTexture2D(const Napi::CallbackInfo& info);
    void _framebufferRenderbuffer(const Napi::CallbackInfo& info);

    // RBOs
    void _genRenderbuffers(const Napi::CallbackInfo& info);
    void _deleteRenderbuffers(const Napi::CallbackInfo& info);
    void _bindRenderbuffer(const Napi::CallbackInfo& info);
    void _renderbufferStorage(const Napi::CallbackInfo& info);

    // Readback
    void _readPixels(const Napi::CallbackInfo& info);

    // ES3 / VAO
    void _genVertexArrays(const Napi::CallbackInfo& info);
    void _deleteVertexArrays(const Napi::CallbackInfo& info);
    void _bindVertexArray(const Napi::CallbackInfo& info);
    void _drawArraysInstanced(const Napi::CallbackInfo& info);
    void _drawElementsInstanced(const Napi::CallbackInfo& info);
    void _vertexAttribDivisor(const Napi::CallbackInfo& info);
    void _drawBuffers(const Napi::CallbackInfo& info);

    // Additional GLES 3.0 functions
    Napi::Value _getStringi(const Napi::CallbackInfo& info);
    Napi::Value _getBooleanv(const Napi::CallbackInfo& info);
    Napi::Value _getFloatv(const Napi::CallbackInfo& info);
    void _texParameteriv(const Napi::CallbackInfo& info);
    void _copyTexSubImage2D(const Napi::CallbackInfo& info);
    void _vertexAttrib4fv(const Napi::CallbackInfo& info);
    void _vertexAttribIPointer(const Napi::CallbackInfo& info);
    void _bindSampler(const Napi::CallbackInfo& info);
    void _samplerParameteri(const Napi::CallbackInfo& info);
    void _samplerParameterf(const Napi::CallbackInfo& info);
    Napi::Value _genSamplers(const Napi::CallbackInfo& info);
    void _deleteSamplers(const Napi::CallbackInfo& info);
    Napi::Value _fenceSync(const Napi::CallbackInfo& info);
    Napi::Value _clientWaitSync(const Napi::CallbackInfo& info);
    void _deleteSync(const Napi::CallbackInfo& info);
    Napi::Value _mapBufferRange(const Napi::CallbackInfo& info);
    Napi::Value _unmapBuffer(const Napi::CallbackInfo& info);

    // Occlusion queries
    void _genQueries(const Napi::CallbackInfo& info);
    void _deleteQueries(const Napi::CallbackInfo& info);
    void _beginQuery(const Napi::CallbackInfo& info);
    void _endQuery(const Napi::CallbackInfo& info);
    Napi::Value _getQueryObjectiv(const Napi::CallbackInfo& info);
    Napi::Value _getQueryObjectuiv(const Napi::CallbackInfo& info);

    // Compressed textures
    void _compressedTexSubImage2D(const Napi::CallbackInfo& info);

    // FBO extensions
    void _blitFramebuffer(const Napi::CallbackInfo& info);
    void _renderbufferStorageMultisample(const Napi::CallbackInfo& info);

    // Shader introspection
    Napi::Value _getActiveUniform(const Napi::CallbackInfo& info);
    Napi::Value _getActiveAttrib(const Napi::CallbackInfo& info);
    Napi::Value _getShaderSource(const Napi::CallbackInfo& info);

    // State queries
    Napi::Value _isEnabled(const Napi::CallbackInfo& info);
    void _getVertexAttribiv(const Napi::CallbackInfo& info);
    void _getVertexAttribfv(const Napi::CallbackInfo& info);
    void _getVertexAttribPointerv(const Napi::CallbackInfo& info);
    void _getRenderbufferParameteriv(const Napi::CallbackInfo& info);
    void _getFramebufferAttachmentParameteriv(const Napi::CallbackInfo& info);
    void _getBufferParameteriv(const Napi::CallbackInfo& info);
    Napi::Value _isTexture(const Napi::CallbackInfo& info);
    Napi::Value _isBuffer(const Napi::CallbackInfo& info);
    Napi::Value _isFramebuffer(const Napi::CallbackInfo& info);
    Napi::Value _isRenderbuffer(const Napi::CallbackInfo& info);
    Napi::Value _isProgram(const Napi::CallbackInfo& info);
    Napi::Value _isShader(const Napi::CallbackInfo& info);
    void _getTexParameteriv(const Napi::CallbackInfo& info);
    void _getTexParameterfv(const Napi::CallbackInfo& info);
    void _getUniformiv(const Napi::CallbackInfo& info);
    void _getUniformfv(const Napi::CallbackInfo& info);
    void _vertexAttrib1f(const Napi::CallbackInfo& info);
    void _vertexAttrib2f(const Napi::CallbackInfo& info);
    void _vertexAttrib3f(const Napi::CallbackInfo& info);
    void _vertexAttrib4f(const Napi::CallbackInfo& info);
    void _sampleCoverage(const Napi::CallbackInfo& info);

    // 3D Textures
    void _texImage3D(const Napi::CallbackInfo& info);
    void _texSubImage3D(const Napi::CallbackInfo& info);
    void _copyTexSubImage3D(const Napi::CallbackInfo& info);
    void _compressedTexImage3D(const Napi::CallbackInfo& info);
    void _compressedTexSubImage3D(const Napi::CallbackInfo& info);

    // Texture Storage
    void _texStorage2D(const Napi::CallbackInfo& info);
    void _texStorage3D(const Napi::CallbackInfo& info);

    // Uniform Buffer Objects
    void _bindBufferRange(const Napi::CallbackInfo& info);
    void _bindBufferBase(const Napi::CallbackInfo& info);
    void _copyBufferSubData(const Napi::CallbackInfo& info);
    Napi::Value _getUniformBlockIndex(const Napi::CallbackInfo& info);
    void _getActiveUniformBlockiv(const Napi::CallbackInfo& info);
    Napi::Value _getActiveUniformBlockName(const Napi::CallbackInfo& info);
    void _uniformBlockBinding(const Napi::CallbackInfo& info);
    void _getUniformIndices(const Napi::CallbackInfo& info);
    void _getActiveUniformsiv(const Napi::CallbackInfo& info);

    // Unsigned int uniforms
    void _uniform1ui(const Napi::CallbackInfo& info);
    void _uniform2ui(const Napi::CallbackInfo& info);
    void _uniform3ui(const Napi::CallbackInfo& info);
    void _uniform4ui(const Napi::CallbackInfo& info);
    void _uniform1uiv(const Napi::CallbackInfo& info);
    void _uniform2uiv(const Napi::CallbackInfo& info);
    void _uniform3uiv(const Napi::CallbackInfo& info);
    void _uniform4uiv(const Napi::CallbackInfo& info);

    // Read buffer / FBO layer
    void _readBuffer(const Napi::CallbackInfo& info);
    void _framebufferTextureLayer(const Napi::CallbackInfo& info);

    // Non-square matrices
    void _uniformMatrix2x3fv(const Napi::CallbackInfo& info);
    void _uniformMatrix3x2fv(const Napi::CallbackInfo& info);
    void _uniformMatrix2x4fv(const Napi::CallbackInfo& info);
    void _uniformMatrix4x2fv(const Napi::CallbackInfo& info);
    void _uniformMatrix3x4fv(const Napi::CallbackInfo& info);
    void _uniformMatrix4x3fv(const Napi::CallbackInfo& info);

    // Clear buffer
    void _clearBufferiv(const Napi::CallbackInfo& info);
    void _clearBufferuiv(const Napi::CallbackInfo& info);
    void _clearBufferfv(const Napi::CallbackInfo& info);
    void _clearBufferfi(const Napi::CallbackInfo& info);

    // Transform feedback
    void _beginTransformFeedback(const Napi::CallbackInfo& info);
    void _endTransformFeedback(const Napi::CallbackInfo& info);
    void _transformFeedbackVaryings(const Napi::CallbackInfo& info);
    Napi::Value _getTransformFeedbackVarying(const Napi::CallbackInfo& info);
    void _genTransformFeedbacks(const Napi::CallbackInfo& info);
    void _deleteTransformFeedbacks(const Napi::CallbackInfo& info);
    void _bindTransformFeedback(const Napi::CallbackInfo& info);
    Napi::Value _isTransformFeedback(const Napi::CallbackInfo& info);
    void _pauseTransformFeedback(const Napi::CallbackInfo& info);
    void _resumeTransformFeedback(const Napi::CallbackInfo& info);

    // Sync & queries (additional)
    Napi::Value _isSync(const Napi::CallbackInfo& info);
    void _waitSync(const Napi::CallbackInfo& info);
    Napi::Value _getInteger64v(const Napi::CallbackInfo& info);
    Napi::Value _getSynciv(const Napi::CallbackInfo& info);
    Napi::Value _getIntegeri_v(const Napi::CallbackInfo& info);
    Napi::Value _getInteger64i_v(const Napi::CallbackInfo& info);

    // Misc GLES 3.0
    Napi::Value _getFragDataLocation(const Napi::CallbackInfo& info);
    Napi::Value _getShaderPrecisionFormat(const Napi::CallbackInfo& info);
    void _drawRangeElements(const Napi::CallbackInfo& info);
    void _getInternalformativ(const Napi::CallbackInfo& info);

    // Framebuffer invalidation
    void _invalidateFramebuffer(const Napi::CallbackInfo& info);
    void _invalidateSubFramebuffer(const Napi::CallbackInfo& info);

    // Integer vertex attribs
    void _vertexAttribI4i(const Napi::CallbackInfo& info);
    void _vertexAttribI4ui(const Napi::CallbackInfo& info);
    void _vertexAttribI4iv(const Napi::CallbackInfo& info);
    void _vertexAttribI4uiv(const Napi::CallbackInfo& info);
    void _getVertexAttribIiv(const Napi::CallbackInfo& info);
    void _getVertexAttribIuiv(const Napi::CallbackInfo& info);

    // Sampler supplementary
    Napi::Value _isSampler(const Napi::CallbackInfo& info);
    void _samplerParameteriv(const Napi::CallbackInfo& info);
    void _samplerParameterfv(const Napi::CallbackInfo& info);
    void _getSamplerParameteriv(const Napi::CallbackInfo& info);
    void _getSamplerParameterfv(const Napi::CallbackInfo& info);

    // Vertex attrib fv variants
    void _vertexAttrib1fv(const Napi::CallbackInfo& info);
    void _vertexAttrib2fv(const Napi::CallbackInfo& info);
    void _vertexAttrib3fv(const Napi::CallbackInfo& info);

    // Query supplementary
    Napi::Value _isQuery(const Napi::CallbackInfo& info);
    Napi::Value _getQueryiv(const Napi::CallbackInfo& info);

    // Misc
    void _texParameterfv(const Napi::CallbackInfo& info);
    void _copyTexImage2D(const Napi::CallbackInfo& info);
    Napi::Value _isVertexArray(const Napi::CallbackInfo& info);
    void _releaseShaderCompiler(const Napi::CallbackInfo& info);
    void _programParameteri(const Napi::CallbackInfo& info);
    void _getBufferParameteri64v(const Napi::CallbackInfo& info);
    void _getUniformuiv(const Napi::CallbackInfo& info);
    void _getAttachedShaders(const Napi::CallbackInfo& info);

    // WASM-incompatible stubs
    void _shaderBinary(const Napi::CallbackInfo& info);
    void _getProgramBinary(const Napi::CallbackInfo& info);
    void _programBinary(const Napi::CallbackInfo& info);
    void _flushMappedBufferRange(const Napi::CallbackInfo& info);
    void _getBufferPointerv(const Napi::CallbackInfo& info);
}
