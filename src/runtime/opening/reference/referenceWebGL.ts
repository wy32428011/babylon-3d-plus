import { GLOBE_VERTEX,GLOBE_FRAGMENT,createGlobeGeometry } from './referenceShaders';
import type { ReferenceGlobeRenderer,ReferenceRendererOptions } from './referenceTypes';

/** 保留用户 HTML 的原生 WebGL 投影、纹理朝向与网格；补齐初始化失败时的资源释放。 */
export function createWebGLRenderer(canvas:HTMLCanvasElement,{images,atlas,onLost}:ReferenceRendererOptions):ReferenceGlobeRenderer {
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl)throw new Error('开场 WebGL 不可用。');
  const buffers:WebGLBuffer[]=[],textures:WebGLTexture[]=[],shaders:WebGLShader[]=[];
  let program:WebGLProgram|null=null;
  let disposed=false;
  const lost=(event:Event)=>{event.preventDefault();if(!disposed)onLost?.();};
  const dispose=()=>{
    if(disposed)return;disposed=true;canvas.removeEventListener('webglcontextlost',lost);
    for(const buffer of buffers)gl.deleteBuffer(buffer);
    for(const texture of textures)gl.deleteTexture(texture);
    for(const shader of shaders)gl.deleteShader(shader);
    if(program)gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    const compile=(type:number,source:string):WebGLShader=>{
      const shader=gl.createShader(type);if(!shader)throw new Error('无法分配开场 shader。');
      shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader)||'开场 shader 编译失败。');
      return shader;
    };
    const vertex=compile(gl.VERTEX_SHADER,GLOBE_VERTEX),fragment=compile(gl.FRAGMENT_SHADER,GLOBE_FRAGMENT);
    program=gl.createProgram();if(!program)throw new Error('无法分配开场 WebGL program。');
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'开场 shader 链接失败。');
    for(const shader of shaders)gl.deleteShader(shader);
    shaders.length=0;
    gl.useProgram(program);
    const geometry=createGlobeGeometry();
    const buffer=(data:Float32Array|Uint16Array,target:number):WebGLBuffer=>{
      const value=gl.createBuffer();if(!value)throw new Error('无法分配开场顶点缓冲。');
      buffers.push(value);gl.bindBuffer(target,value);gl.bufferData(target,data,gl.STATIC_DRAW);return value;
    };
    buffer(geometry.uvs,gl.ARRAY_BUFFER);
    const uv=gl.getAttribLocation(program,'uv');
    if(uv<0)throw new Error('开场 shader 缺少 UV 属性。');
    gl.enableVertexAttribArray(uv);gl.vertexAttribPointer(uv,2,gl.FLOAT,false,0,0);
    const indices=buffer(geometry.indices,gl.ELEMENT_ARRAY_BUFFER);
    const texture=(image:HTMLImageElement,unit:number,uniform:string)=>{
      const value=gl.createTexture();if(!value)throw new Error('无法分配开场纹理。');
      textures.push(value);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,value);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program!,uniform),unit);
    };
    texture(atlas,0,'u_atlas');texture(images[2],1,'u_world');
    const view=gl.getUniformLocation(program,'u_view'),morph=gl.getUniformLocation(program,'u_morph');
    const yaw=gl.getUniformLocation(program,'u_yaw'),pitch=gl.getUniformLocation(program,'u_pitch');
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.clearColor(0,0,0,0);
    canvas.addEventListener('webglcontextlost',lost);
    return {
      kind:'webgl',
      resize({width,height,dpr,viewW,viewH}){
        if(disposed)return;
        canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
        gl.viewport(0,0,canvas.width,canvas.height);gl.useProgram(program);gl.uniform2f(view,viewW,viewH);
      },
      draw(frame){
        if(disposed||gl.isContextLost())return;
        gl.useProgram(program);gl.uniform1f(morph,frame.morph);gl.uniform1f(yaw,frame.yaw);gl.uniform1f(pitch,frame.pitch);
        gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);
        gl.drawElements(gl.TRIANGLES,geometry.indices.length,gl.UNSIGNED_SHORT,0);
      },
      dispose,
    };
  } catch(error) {dispose();throw error;}
}
