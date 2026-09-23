export const SURFACE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
#ifdef HEAT_VERTEX
attribute vec4 color;
varying vec4 vColor;
#endif
uniform mat4 worldViewProjection;
varying vec2 vUv;
varying vec3 vLocal;
void main() {
  vUv=uv; vLocal=position;
  #ifdef HEAT_VERTEX
  vColor=color;
  #endif
  gl_Position=worldViewProjection*vec4(position,1.0);
}`;

export const SURFACE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying vec3 vLocal;
#ifdef HEAT_VERTEX
varying vec4 vColor;
#endif
uniform vec3 primary;
uniform vec3 secondary;
uniform float opacity;
uniform float intensity;
uniform float time;
uniform float mode;
uniform float thickness;
uniform float progress;
uniform float amount;
uniform vec4 detail;
uniform vec4 shape;
uniform vec4 wave;
const float PI=3.14159265359;
const float TAU=6.28318530718;
float line(float distance,float width) { return 1.0-smoothstep(width,width*1.8+0.0001,abs(distance)); }
void main() {
  vec2 p=vUv*2.0-1.0; float radius=length(p);
  float a=1.0; float glow=1.0; vec3 rgb=primary;
  if(mode<0.5) {
    float wave=pow(0.5+0.5*cos((vUv.x*amount-time)*TAU),14.0);
    a=(0.22+wave*0.78)*pow(max(0.0,1.0-abs(p.y)),0.65);
    rgb=mix(primary,secondary,wave); glow=0.7+wave*1.4;
  } else if(mode<1.5) {
    vec2 grid=abs(fract(vLocal.xz/max(0.01,detail.x))-0.5);
    float gridLine=step(0.48,max(grid.x,grid.y)); a=0.30+gridLine*0.45;
  } else if(mode<2.5) {
    if(radius>1.0) discard;
    float ring=fract(radius*max(1.0,amount)-time);
    a=pow(1.0-ring,shape.w)*smoothstep(0.0,0.12,radius)*pow(1.0-radius,detail.y);
    glow=1.3; rgb=mix(primary,secondary,ring);
  } else if(mode<3.5) {
    float pulse=mix(detail.z,detail.w,0.5+0.5*sin(time*TAU));
    float outer=line(radius-(0.82+0.025*pulse),thickness);
    float inner=line(radius-0.60,thickness*0.50);
    float tick=step(0.6,sin(atan(p.y,p.x)*shape.x*2.0))*line(radius-0.94,0.014)*step(0.1,shape.x);
    a=(outer+inner*0.45+tick*0.65)*pulse; glow=1.2;
  } else if(mode<4.5) {
    if(radius>1.0) discard;
    float angle=fract(atan(p.y,p.x)/TAU-time-shape.y+1.0);
    float sector=clamp(amount/360.0,0.015,0.95);
    float sweep=(1.0-smoothstep(0.0,sector,angle))*step(angle,sector);
    float rings=line(fract(radius*shape.z),0.01)*0.28*step(0.1,shape.z);
    a=(sweep*0.78+rings+line(radius-0.98,0.008))*smoothstep(0.0,0.04,radius);
    rgb=mix(primary,secondary,pow(sweep,8.0));
  } else if(mode<5.5) {
    float scan=pow(0.5+0.5*cos((vUv.y*3.0-time)*TAU),12.0);
    float columns=pow(abs(sin(vUv.x*TAU*8.0)),16.0);
    a=pow(1.0-vUv.y,0.7)*(0.15+scan*0.4+columns*0.4); glow=1.3;
  } else if(mode<6.5) {
    vec2 cells=vec2(vUv.x*shape.x,vUv.y*shape.z);
    cells.x+=mod(floor(cells.y),2.0)*0.5;
    vec2 cell=abs(fract(cells)-0.5);
    float hexEdge=line(max(cell.x*0.866+cell.y*0.5,cell.y)-0.45,shape.w);
    a=(0.08+hexEdge*0.55)*(0.7+0.3*sin(time*TAU));
    rgb=mix(primary,secondary,hexEdge); glow=1.2;
  } else if(mode<7.5) {
    float lit=step(vUv.x,progress);
    a=(0.12+lit*0.88)*pow(max(0.0,1.0-abs(p.y)),0.5);
    rgb=mix(secondary*0.35,primary,lit);
  } else if(mode<8.5) {
    vec2 waterPosition=mat2(cos(wave.z),-sin(wave.z),sin(wave.z),cos(wave.z))*vLocal.xz;
    float waves=sin(waterPosition.x*wave.x+time*TAU)*cos(waterPosition.y*wave.x*0.73913-time*TAU*2.0);
    float fine=sin((waterPosition.x+waterPosition.y)*wave.x*2.17391+time*TAU*3.0);
    float crest=pow(clamp(waves*0.55+fine*0.2+0.3,0.0,1.0),7.0);
    crest=clamp(crest*wave.y,0.0,1.0); rgb=mix(primary*0.45,secondary,crest); a=0.55+crest*0.4;
  } else if(mode>9.5) {
    a=pow(vUv.x,detail.y)*pow(max(0.0,1.0-abs(p.y)),0.65);
    rgb=mix(primary,secondary,vUv.x); glow=1.3;
  }
  #ifdef HEAT_VERTEX
  rgb=vColor.rgb; a=vColor.a;
  #endif
  if(a*opacity<0.001) discard;
  gl_FragColor=vec4(rgb*intensity*glow,a*opacity);
}`;

export const PARTICLE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform float time;
uniform float height;
uniform float radius;
uniform float size;
uniform float mode;
uniform float configured;
uniform float lifetime;
uniform float particleSpeed;
uniform float emitterRadius;
uniform float emissionFraction;
uniform float particleClock;
uniform float stoppedAt;
uniform vec3 emissionDirection;
uniform vec3 gravity;
uniform vec3 wind;
varying vec2 vUv;
varying float age;
varying float seed;
varying float alive;
void main() {
  vUv=uv; seed=color.r; age=fract(color.b+time); alive=1.0;
  vec3 center=position;
  if(mode<1.5) {
    center.y=height*(1.0-age);
    if(mode>0.5) center.xz+=vec2(sin((age+seed)*6.283),cos((age+seed)*6.283))*radius*0.035;
  } else {
    center.y=height*age;
    center.xz*=0.35+age;
    center.x+=sin(age*8.0+seed*6.283)*radius*age*0.3;
  }
  if(configured>0.5) {
    age=fract(color.b+particleClock/max(0.05,lifetime));
    float seconds=age*lifetime;
    vec3 origin=vec3(cos(color.r*6.283),0.0,sin(color.r*6.283))*sqrt(color.g)*emitterRadius;
    if(mode<1.5) origin.y=height;
    center=origin+emissionDirection*particleSpeed*seconds+gravity*seconds*seconds*0.5+wind*seconds;
  }
  alive=step(color.a,emissionFraction);
  if(stoppedAt>=0.0) alive*=step(particleClock-age*lifetime,stoppedAt);
  vec4 viewPosition=view*world*vec4(center,1.0);
  float scale=size*(0.55+color.a*0.45);
  if(mode>1.5) scale*=0.55+age*1.5;
  vec2 quad=(uv-0.5)*scale;
  if(mode<0.5) quad.x*=0.055;
  if(mode>1.5&&mode<2.5) quad.y*=1.7;
  viewPosition.xy+=quad;
  gl_Position=projection*viewPosition;
}`;

export const PARTICLE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying float age;
varying float seed;
varying float alive;
uniform float mode;
uniform float opacity;
uniform float intensity;
uniform vec3 primary;
uniform vec3 secondary;
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
}
void main() {
  vec2 p=vUv*2.0-1.0;
  float alpha=1.0; vec3 rgb=primary;
  if(mode<0.5) alpha=(1.0-abs(p.x))*pow(1.0-abs(p.y),0.4);
  else if(mode<1.5) alpha=1.0-smoothstep(0.25,1.0,length(p));
  else if(mode<2.5) {
    float warp=noise(p*4.0+vec2(seed*10.0,-age*5.0));
    alpha=clamp(1.0-length(vec2(p.x*(1.0+vUv.y),p.y))-warp*0.3,0.0,1.0);
    alpha*=smoothstep(0.0,0.15,age)*(1.0-age); rgb=mix(secondary,primary,age);
  } else {
    float cloud=noise(p*3.0+seed*10.0)*0.65+noise(p*7.0)*0.35;
    alpha=(1.0-smoothstep(0.25,1.0,length(p)))*cloud*smoothstep(0.0,0.15,age)*(1.0-age);
    rgb=mix(primary,secondary,age);
  }
  alpha*=alive;
  if(alpha*opacity<0.001) discard;
  gl_FragColor=vec4(rgb*intensity,alpha*opacity);
}`;

