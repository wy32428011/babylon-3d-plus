export const GLOBE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform float u_morph;
uniform float u_yaw;
uniform float u_pitch;
uniform vec2 u_view;
varying vec2 vUV;
varying vec3 vNormal;
const float PI=3.141592653589793;
void main(){
  vUV=uv;
  float m=u_morph;
  float lon=(uv.x-0.5)*2.0*PI-u_yaw*(1.0-m);
  float lat=(0.5-uv.y)*PI;
  float k=max(0.0001,1.0-m);
  float rx=mix(3.65,14.2/(2.0*PI),m);
  float ry=mix(3.65,(14.2*941.0/1672.0)/PI,m);
  vec3 p;
  p.x=rx/k*cos(lat*k)*sin(lon*k);
  p.y=ry/k*sin(lat*k);
  p.z=3.65/k*(1.0-cos(lat*k)*cos(lon*k))-3.65*(1.0-m);
  if(m>0.999){p=vec3((uv.x-.5)*14.2,(.5-uv.y)*(14.2*941.0/1672.0),0.0);}
  float pitch=u_pitch*(1.0-m);
  float c=cos(pitch),s=sin(pitch);
  p.yz=mat2(c,-s,s,c)*p.yz;
  p.xy*=1.0-.26*sin(PI*m);
  p.x+=1.20*(1.0-m);
  p.y+=.08*(1.0-m)+.20*m;
  vec3 n=vec3(cos(lat)*sin(lon),sin(lat),-cos(lat)*cos(lon));
  n.yz=mat2(c,-s,s,c)*n.yz;
  vNormal=n;
  gl_Position=vec4(p.x/(u_view.x*.5),p.y/(u_view.y*.5),p.z/80.0,1.0);
}`;
export const GLOBE_FRAGMENT = `
precision highp float;
uniform sampler2D u_atlas;
uniform sampler2D u_world;
uniform float u_morph;
varying vec2 vUV;
varying vec3 vNormal;
void main(){
  vec3 earth=texture2D(u_atlas,vUV).rgb;
  vec3 world=texture2D(u_world,vUV).rgb;
  vec3 col=mix(earth,world,smoothstep(.0,.12,u_morph));
  float rim=pow(1.0-clamp(-normalize(vNormal).z,0.0,1.0),4.0)*(1.0-u_morph);
  col+=vec3(.035,.22,.52)*rim*.55;
  gl_FragColor=vec4(col,1.0);
}`;
export function createGlobeGeometry(nx=256,ny=128){
  const positions=new Float32Array((nx+1)*(ny+1)*3);
  const uvs=new Float32Array((nx+1)*(ny+1)*2);
  const indices=new Uint16Array(nx*ny*6);
  let vi=0,ui=0,ii=0;
  for(let y=0;y<=ny;y++) for(let x=0;x<=nx;x++){
    const u=x/nx,v=y/ny;
    positions[vi++]=(u-.5)*14.2;positions[vi++]=(.5-v)*8;positions[vi++]=0;
    uvs[ui++]=u;uvs[ui++]=v;
  }
  for(let y=0;y<ny;y++) for(let x=0;x<nx;x++){
    const a=y*(nx+1)+x,b=a+1,c=a+nx+1,d=c+1;
    indices[ii++]=a;indices[ii++]=c;indices[ii++]=b;
    indices[ii++]=b;indices[ii++]=c;indices[ii++]=d;
  }
  return {positions,uvs,indices};
}


