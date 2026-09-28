// 从用户提供的 zd_digital_twin_opening.html 抽取，保持原软件球面和三角形展开算法。
export function createSoftwareRenderer(canvas,{images,atlas}){
 const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Software canvas unavailable');
 const texCanvas=document.createElement('canvas');texCanvas.width=1536;texCanvas.height=768;
 const tex=texCanvas.getContext('2d',{willReadFrequently:true});tex.drawImage(atlas,0,0,1536,768);
 const atlasPixels=tex.getImageData(0,0,1536,768).data;
 const sphereCanvas=document.createElement('canvas');const sphere=sphereCanvas.getContext('2d');
 let size={width:1600,height:900,dpr:1,scale:1,ox:0,oy:0},disposed=false,sphereSize=0,pixelMap=null,framePixels=null,lastPitch=NaN;
 const nx=88,ny=44,vertices=[],triangles=[];
 for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++)vertices.push({u:x/nx,v:y/ny,x:0,y:0,z:0});
 for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const a=y*(nx+1)+x,b=a+1,c=a+nx+1,d=c+1;triangles.push({a,b:c,c:b,z:0},{a:b,b:c,c:d,z:0});}
 function buildPixelMap(pitch){
  const n=Math.min(720,Math.max(280,Math.round(730*size.scale*size.dpr)));sphereSize=n;lastPitch=pitch;sphereCanvas.width=sphereCanvas.height=n;framePixels=sphere.createImageData(n,n);
  pixelMap=[];const c=Math.cos(pitch),s=Math.sin(pitch);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
   const xx=(x+.5)/n*2-1,yy=1-(y+.5)/n*2,q=1-xx*xx-yy*yy;if(q<=0)continue;
   const zz=-Math.sqrt(q),sy=yy*c-zz*s,sz=yy*s+zz*c;
   const u=(Math.atan2(xx,-sz)/(Math.PI*2)+.5)*1536;
   const v=Math.max(0,Math.min(767,(.5-Math.asin(Math.max(-1,Math.min(1,sy)))/Math.PI)*768));
   const rim=Math.pow(1+zz,4)*.55;
   pixelMap.push({out:(y*n+x)*4,u,y:Math.min(766,Math.floor(v)),fy:v-Math.floor(v),rim});
   framePixels.data[(y*n+x)*4+3]=255;
  }
 }
 function drawSphere(yaw,pitch){
  if(!pixelMap||pitch!==lastPitch)buildPixelMap(pitch);
  const offset=yaw/(Math.PI*2)*1536,d=framePixels.data;
  for(const p of pixelMap){
   const sample=((p.u+offset)%1536+1536)%1536,x=Math.floor(sample),fx=sample-x,x2=(x+1)%1536;
   const a=(p.y*1536+x)*4,b=(p.y*1536+x2)*4,c=a+1536*4,e=b+1536*4;
   for(let channel=0;channel<3;channel++){
    const upper=atlasPixels[a+channel]*(1-fx)+atlasPixels[b+channel]*fx,lower=atlasPixels[c+channel]*(1-fx)+atlasPixels[e+channel]*fx;
    d[p.out+channel]=Math.min(255,upper*(1-p.fy)+lower*p.fy+p.rim*[.035,.22,.52][channel]*255);
   }
  }
  sphere.putImageData(framePixels,0,0);ctx.drawImage(sphereCanvas,555,77,730,730);
 }
 function texturedTriangle(a,b,c){
  const sx0=a.u*1536,sy0=a.v*768,sx1=b.u*1536,sy1=b.v*768,sx2=c.u*1536,sy2=c.v*768;
  const dx1=sx1-sx0,dy1=sy1-sy0,dx2=sx2-sx0,dy2=sy2-sy0,det=dx1*dy2-dx2*dy1;
  if(Math.abs(det)<1e-8)return;
  const area=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);if(Math.abs(area)<.045)return;
  const A=((b.x-a.x)*dy2-(c.x-a.x)*dy1)/det,C=((c.x-a.x)*dx1-(b.x-a.x)*dx2)/det;
  const B=((b.y-a.y)*dy2-(c.y-a.y)*dy1)/det,D=((c.y-a.y)*dx1-(b.y-a.y)*dx2)/det;
  const E=a.x-A*sx0-C*sy0,F=a.y-B*sx0-D*sy0;
  ctx.save();const mx=(a.x+b.x+c.x)/3,my=(a.y+b.y+c.y)/3;
  ctx.beginPath();for(const [i,p] of [a,b,c].entries()){
   const dx=p.x-mx,dy=p.y-my,l=Math.hypot(dx,dy)||1,x=p.x+dx/l*.45,y=p.y+dy/l*.45;
   i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  }ctx.closePath();ctx.clip();ctx.transform(A,B,C,D,E,F);ctx.drawImage(texCanvas,0,0);ctx.restore();
 }
 function drawUnfold(m,yaw,pitch){
  if(m>.999){ctx.drawImage(images[2],90,430-(1420*941/1672)/2,1420,1420*941/1672);return;}
  const k=Math.max(.0001,1-m),rx=3.65+(14.2/(Math.PI*2)-3.65)*m,ry=3.65+((14.2*941/1672)/Math.PI-3.65)*m;
  const cp=Math.cos(pitch*(1-m)),sp=Math.sin(pitch*(1-m));
  for(const p of vertices){
   const lon=(p.u-.5)*Math.PI*2-yaw*(1-m),lat=(.5-p.v)*Math.PI;
   const x=rx/k*Math.cos(lat*k)*Math.sin(lon*k),y=ry/k*Math.sin(lat*k),z=3.65/k*(1-Math.cos(lat*k)*Math.cos(lon*k))-3.65*(1-m);
   const fit=1-.26*Math.sin(Math.PI*m);p.x=800+(x*fit+1.2*(1-m))*100;p.y=450-((y*cp+z*sp)*fit+.08*(1-m)+.20*m)*100;p.z=-y*sp+z*cp;
  }
  const q=Math.max(0,Math.min(1,m/.12)),blend=q*q*(3-2*q);
  tex.globalAlpha=1;tex.drawImage(atlas,0,0,1536,768);if(blend>0){tex.globalAlpha=blend;tex.drawImage(images[2],0,0,1536,768);tex.globalAlpha=1;}
  for(const tri of triangles)tri.z=(vertices[tri.a].z+vertices[tri.b].z+vertices[tri.c].z)/3;
  triangles.sort((a,b)=>b.z-a.z);
  for(const tri of triangles){const a=vertices[tri.a],b=vertices[tri.b],c=vertices[tri.c];if(Math.max(a.x,b.x,c.x)<-100||Math.min(a.x,b.x,c.x)>1700||Math.max(a.y,b.y,c.y)<-150||Math.min(a.y,b.y,c.y)>1050)continue;texturedTriangle(a,b,c);}
 }
 return {
  kind:'Canvas3D · 软件兼容',
  resize(next){size=next;canvas.width=Math.round(size.width*size.dpr);canvas.height=Math.round(size.height*size.dpr);pixelMap=null;},
  draw({morph,yaw,pitch}){
   if(disposed)return;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
   ctx.setTransform(size.scale*size.dpr,0,0,size.scale*size.dpr,size.ox*size.dpr,size.oy*size.dpr);
   if(morph<.00001)drawSphere(yaw,pitch);else drawUnfold(morph,yaw,pitch);
  },
  dispose(){disposed=true;pixelMap=null;framePixels=null;canvas.width=canvas.height=texCanvas.width=texCanvas.height=sphereCanvas.width=sphereCanvas.height=1;}
 };
}


