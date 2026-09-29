// 从用户提供的参考 HTML 抽取；原绘制常量与分镜保持，配置仅注入UV路线和呼吸时钟。
const clamp01=x=>Math.max(0,Math.min(1,x));
// 可调镜头轴会让局部呼吸时钟为负；循环相位必须取正模，避免脉冲半径和透明度越界。
const cyclePhase=x=>((x%1)+1)%1;
const lerp=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,x)=>{const t=clamp01((x-a)/(b-a));return t*t*(3-2*t);};
const easeQuint=t=>{t=clamp01(t);return t<.5?16*t*t*t*t*t:1-Math.pow(-2*t+2,5)/2;};
const mapRect=(w,h,cx=800,cy=430)=>({w,h,cx,cy});
const MAP_RECTS={world:mapRect(1420,1420*941/1672),china:mapRect(1080,720),jiangsu:mapRect(960,720),wuxi:mapRect(960,720),huishan:mapRect(1120,840,900,430)};
const uvPoint=(r,u,v)=>({x:r.cx+(u-.5)*r.w,y:r.cy+(v-.5)*r.h});
function routeData(origin,destinations,overrides){
  return destinations.map(([name,x,y],i)=>{
    const custom=overrides?.[i],from=custom?[custom.from.x,custom.from.y]:origin;
    const dx=x-from[0],dy=y-from[1],dist=Math.hypot(dx,dy);
    const control=custom?.curvature===undefined
      ?[(x+from[0])*.5+(i%3-1)*.018,Math.max(.035,Math.min(y,from[1])-Math.min(.22,.055+dist*.27))]
      :[(x+from[0])*.5,(y+from[1])*.5-custom.curvature*dist];
   const points=[];
   for(let j=0;j<=80;j++){
     const p=j/80,q=1-p;
      points.push([q*q*from[0]+2*q*p*control[0]+p*p*x,q*q*from[1]+2*q*p*control[1]+p*p*y]);
   }
    return {name,points,dest:[x,y],gold:i%4===0,delay:(i%7)*.095+Math.floor(i/7)*.12,period:2.0+(i%7)*.24,phase:(i*.217)%1,
      color:custom?.color,width:custom?.width,speed:custom?.speed,trail:custom?.trail,pulse:custom?.pulse};
 });
}
export function globeState(t){return {morph:smooth(9,15.55,t),yaw:lerp(-2.05,1.10,smooth(0,6.8,t)),pitch:.30};}
/** All anchors here belong to the reference artwork, not a geographic projection. */
export function createPainter(backCanvas,effectsCanvas,images,configuration){
 const WORLD_ORIGIN=configuration.worldOrigin,CHINA_ORIGIN=configuration.chinaOrigin;
 const WORLD_FOCUS=[.709,.335],CHINA_FOCUS=[.707,.520];
 const WORLD_DESTINATIONS=configuration.worldDestinations,CHINA_DESTINATIONS=configuration.chinaDestinations;
 let actualSeconds=0,referenceSeconds=0;
 const breathing=configuration.breathing;
 const strength=()=>breathing.enabled&&Number.isFinite(breathing.intensity)?Math.max(0,Math.min(1,breathing.intensity)):0;
 const effectTime=t=>strength()>0?(t+actualSeconds-referenceSeconds)*4/Math.max(2,Math.min(10,breathing.periodSeconds||4)):0;
 const amplitude=()=>Math.min(1.5,strength()/.65);

 const bg=backCanvas.getContext('2d',{alpha:false}),ctx=effectsCanvas.getContext('2d');
 if(!bg||!ctx)throw new Error('Canvas2D is unavailable');
 const faded=new WeakMap();
 function feather(source){
  if(faded.has(source))return faded.get(source);
  const c=document.createElement('canvas');c.width=source.naturalWidth;c.height=source.naturalHeight;const f=c.getContext('2d');f.drawImage(source,0,0);f.globalCompositeOperation='destination-in';
  for(const horizontal of [true,false]){const g=f.createLinearGradient(0,0,horizontal?c.width:0,horizontal?0:c.height);g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(.025,'rgba(0,0,0,1)');g.addColorStop(.975,'rgba(0,0,0,1)');g.addColorStop(1,'rgba(0,0,0,0)');f.fillStyle=g;f.fillRect(0,0,c.width,c.height);}
  faded.set(source,c);return c;
 }
 for(const key of [2,4,5,7,8,9])feather(images[key]);
 const worldRoutes=routeData(WORLD_ORIGIN,WORLD_DESTINATIONS,configuration.worldRouteOverrides),chinaRoutes=routeData(CHINA_ORIGIN,CHINA_DESTINATIONS,configuration.chinaRouteOverrides);
 let seed=95213;
 const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
 const stars=Array.from({length:390},()=>({x:random()*1800-100,y:random()*1100-100,r:.35+random()*1.25,a:.13+random()*.56,phase:random()*6.28}));
 const streaks=Array.from({length:40},(_,i)=>({angle:i/40*Math.PI*2+random()*.08,d:.4+random()*.6}));
 let size={width:1600,height:900,dpr:1,scale:1,ox:0,oy:0};
 function prepare(c,clear=true){
   c.setTransform(1,0,0,1,0,0);if(clear)c.clearRect(0,0,c.canvas.width,c.canvas.height);
   c.setTransform(size.dpr*size.scale,0,0,size.dpr*size.scale,size.dpr*size.ox,size.dpr*size.oy);
 }
 function background(t){
   const fxTime=effectTime(t),fxAmplitude=amplitude();
   bg.setTransform(1,0,0,1,0,0);bg.fillStyle='#020813';bg.fillRect(0,0,backCanvas.width,backCanvas.height);prepare(bg,false);
   let nebula=bg.createRadialGradient(920,330,30,820,450,900);nebula.addColorStop(0,'rgba(9,49,82,.36)');nebula.addColorStop(.48,'rgba(6,29,57,.32)');nebula.addColorStop(1,'rgba(0,3,10,0)');bg.fillStyle=nebula;bg.fillRect(-200,-200,2000,1300);
   for(const star of stars){
     const x=star.x+Math.sin(fxTime*.055+star.phase)*3*fxAmplitude,y=star.y+Math.cos(fxTime*.04+star.phase)*2*fxAmplitude;
     bg.globalAlpha=star.a*(.65+.35*Math.sin(fxTime*.7+star.phase)*fxAmplitude);bg.fillStyle=star.r>1.4?'#77caff':'#c1dcee';bg.beginPath();bg.arc(x,y,star.r,0,Math.PI*2);bg.fill();
     if(star.r>1.5){bg.globalAlpha*=.26;bg.fillRect(x-4,y-.35,8,.7);bg.fillRect(x-.35,y-4,.7,8);}
   }
   bg.globalAlpha=1;bg.strokeStyle='rgba(66,158,205,.075)';bg.lineWidth=.8;
   for(let r=310;r<=770;r+=80){bg.beginPath();bg.ellipse(800,430,r,r*.88,0,0,Math.PI*2);bg.stroke();}
   bg.strokeStyle='rgba(53,150,202,.07)';for(let a=0;a<Math.PI*2;a+=Math.PI/12){bg.beginPath();bg.moveTo(800+Math.cos(a)*310,430+Math.sin(a)*270);bg.lineTo(800+Math.cos(a)*820,430+Math.sin(a)*720);bg.stroke();}
   if(t<16){
     const {morph:m}=globeState(t),x=lerp(920,800,m),y=lerp(442,430,m);
     bg.globalAlpha=(1-smooth(.05,.65,m))*smooth(0,1.2,t);
     const halo=bg.createRadialGradient(x,y,344,x,y,429);halo.addColorStop(0,'rgba(0,98,229,0)');halo.addColorStop(.23,'rgba(42,151,255,.29)');halo.addColorStop(.40,'rgba(17,119,255,.20)');halo.addColorStop(.67,'rgba(5,69,177,.07)');halo.addColorStop(1,'rgba(0,31,83,0)');bg.fillStyle=halo;bg.fillRect(x-460,y-460,920,920);
     bg.strokeStyle='rgba(109,202,255,.48)';bg.lineWidth=1.4;bg.beginPath();bg.arc(x,y,367,0,Math.PI*2);bg.stroke();bg.globalAlpha=1;
   }
 }
 function image(r,image,alpha=1){if(alpha<=.001)return;ctx.save();ctx.globalAlpha*=alpha;ctx.drawImage(feather(image),r.cx-r.w/2,r.cy-r.h/2,r.w,r.h);ctx.restore();}
 function rings(point,radius,t,alpha=.5,gold=false,ellipse=1){
   if(alpha<.001)return;ctx.save();ctx.globalCompositeOperation='lighter';
   const rgb=gold?'255,199,79':'64,203,255';
   for(let i=0;i<3;i++){
    const moving=cyclePhase(effectTime(t)*.34+i/3),p=i/3+(moving-i/3)*Math.min(1,amplitude()),r=radius*(.34+p*.96);
     ctx.strokeStyle=`rgba(${rgb},${(1-p)*alpha})`;ctx.lineWidth=1.1;ctx.beginPath();ctx.ellipse(point.x,point.y,r,r*ellipse,0,0,Math.PI*2);ctx.stroke();
   }
   ctx.fillStyle=`rgba(${rgb},${alpha*.2})`;ctx.beginPath();ctx.ellipse(point.x,point.y,radius*.3,radius*.3*ellipse,0,0,Math.PI*2);ctx.fill();ctx.restore();
 }
 function lockBrackets(point,radius,alpha,t){
   ctx.save();ctx.strokeStyle=`rgba(255,213,122,${alpha*.7})`;ctx.lineWidth=1.3;
   const s=radius+Math.sin(effectTime(t)*1.5)*2*amplitude();
   for(const dx of [-1,1])for(const dy of [-1,1]){const x=point.x+s*dx,y=point.y+s*.67*dy;ctx.beginPath();ctx.moveTo(x-dx*15,y);ctx.lineTo(x,y);ctx.lineTo(x,y-dy*15);ctx.stroke();}
   ctx.restore();
 }
 function flightNetwork(rect,routes,origin,age,t,alpha=1){
   if(age<=0||alpha<=.001)return;
   ctx.save();ctx.globalAlpha*=alpha;ctx.globalCompositeOperation='lighter';
   const relativeScale=rect.w/(routes===worldRoutes?1420:1080);
   for(let i=0;i<routes.length;i++){
     const route=routes[i],reveal=smooth(route.delay,route.delay+1.65,age);
     if(reveal<=0||route.width===0)continue;
     const steps=Math.max(1,Math.floor(80*reveal));
     const hex=route.color?.slice(1),expanded=hex?.length===3?hex.split('').map(c=>c+c).join(''):hex;
     const rgb=expanded?[0,2,4].map(start=>parseInt(expanded.slice(start,start+2),16)).join(','):route.gold?'255,194,94':'59,187,255';
     ctx.save();if(expanded?.length===8)ctx.globalAlpha*=parseInt(expanded.slice(6),16)/255;
     ctx.lineWidth=route.width===undefined?Math.max(.95,Math.min(1.9,relativeScale*1.25)):route.width*relativeScale;ctx.strokeStyle=`rgba(${rgb},${.64*reveal})`;
     ctx.beginPath();route.points.slice(0,steps+1).forEach((p,n)=>{const q=uvPoint(rect,p[0],p[1]);n?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.stroke();
     const phase=((Math.max(0,age-route.delay-0.2)*(route.speed??(1/route.period))+route.phase)%1),head=Math.min(steps,Math.floor(phase*80));
     if(head>0){
       const tail=Math.max(0,head-Math.round((route.trail??.15)*80)),tailUV=route.points[tail],headUV=route.points[head],last=uvPoint(rect,tailUV[0],tailUV[1]),now=uvPoint(rect,headUV[0],headUV[1]);
       const g=ctx.createLinearGradient(last.x,last.y,now.x+.001,now.y+.001);g.addColorStop(0,`rgba(${rgb},0)`);g.addColorStop(.65,`rgba(${rgb},.65)`);g.addColorStop(1,route.gold?'#fff1c9':'#d2faff');
       ctx.strokeStyle=g;ctx.lineWidth=route.width===undefined?2.1*Math.min(relativeScale,2):route.width*relativeScale;ctx.shadowBlur=10;ctx.shadowColor=`rgb(${rgb})`;
       ctx.beginPath();for(let n=tail;n<=head;n++){const p=uvPoint(rect,...route.points[n]);n===tail?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y);}ctx.stroke();ctx.shadowBlur=0;
       const glow=ctx.createRadialGradient(now.x,now.y,0,now.x,now.y,7);glow.addColorStop(0,route.gold?'rgba(255,241,197,.9)':'rgba(211,250,255,.95)');glow.addColorStop(.28,`rgba(${rgb},.7)`);glow.addColorStop(1,`rgba(${rgb},0)`);ctx.fillStyle=glow;ctx.fillRect(now.x-7,now.y-7,14,14);
       if(i%6===0){const prev=uvPoint(rect,...route.points[Math.max(0,head-1)]);ctx.save();ctx.translate(now.x,now.y);ctx.rotate(Math.atan2(now.y-prev.y,now.x-prev.x));ctx.fillStyle=route.gold?'#ffedbd':'#bcf3ff';ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(-4,-3);ctx.lineTo(-2,0);ctx.lineTo(-4,3);ctx.closePath();ctx.fill();ctx.restore();}
     }
    if(reveal>.92){const p=uvPoint(rect,...route.dest);const moving=cyclePhase(effectTime(age)*.40+route.phase),pulse=route.phase+(moving-route.phase)*Math.min(1,amplitude());if(route.pulse!==false){ctx.strokeStyle=`rgba(${rgb},${.48*(1-pulse)})`;ctx.lineWidth=.8;ctx.beginPath();ctx.arc(p.x,p.y,3+pulse*8,0,Math.PI*2);ctx.stroke();}ctx.fillStyle=route.color?`rgb(${rgb})`:(route.gold?'#ffe7ae':'#a4eeff');ctx.beginPath();ctx.arc(p.x,p.y,1.7,0,Math.PI*2);ctx.fill();}
     ctx.restore();
   }
   ctx.restore();rings(uvPoint(rect,...origin),38*Math.min(relativeScale,2),t,.65*alpha,true);
 }
 function finaleEffects(rect,t){
   const p=uvPoint(rect,.556,.546);const scale=rect.w/1120;
   rings(p,118*scale,t,.48,true,.36);
   ctx.save();ctx.globalCompositeOperation='lighter';
   const beam=ctx.createLinearGradient(p.x,p.y-170*scale,p.x,p.y);beam.addColorStop(0,'rgba(255,207,107,0)');beam.addColorStop(.76,'rgba(255,207,107,.025)');beam.addColorStop(1,'rgba(255,207,107,.15)');ctx.fillStyle=beam;ctx.beginPath();ctx.moveTo(p.x-6,p.y-170*scale);ctx.lineTo(p.x+6,p.y-170*scale);ctx.lineTo(p.x+23*scale,p.y);ctx.lineTo(p.x-23*scale,p.y);ctx.closePath();ctx.fill();
   // Sparse animated gold particles suggest data entering the highlighted site.
  for(let i=0;i<14;i++){const q=cyclePhase(effectTime(t)*.19+i*.079),x=p.x+Math.sin(i*2.43)*16*scale,y=p.y-q*145*scale;ctx.fillStyle=`rgba(255,224,151,${Math.sin(q*Math.PI)*.55})`;ctx.fillRect(x,y,1.4,3.5);}
   ctx.restore();
 }
 function drawMap(kind,rect,t,alpha=1){
   if(alpha<.002)return;ctx.save();ctx.globalAlpha*=alpha;
   if(kind==='world'){
     image(rect,images[2]);if(configuration.worldRoutesEnabled)flightNetwork(rect,worldRoutes,WORLD_ORIGIN,t-16,t,smooth(16,17,t));
   }else if(kind==='china'){
     image(rect,images[4]);image(rect,images[5],smooth(30,31.4,t));
     if(t>=30)rings(uvPoint(rect,...CHINA_FOCUS),40*rect.w/1080,t,.35*smooth(30,31,t),true);
     if(configuration.chinaRoutesEnabled)flightNetwork(rect,chinaRoutes,CHINA_ORIGIN,t-34,t,smooth(34,35,t));
   }else if(kind==='jiangsu'){
     image(rect,images[7]);rings(uvPoint(rect,.586,.739),45*rect.w/960,t,.35,true);lockBrackets(uvPoint(rect,.586,.739),62*rect.w/960,.25,t);
   }else if(kind==='wuxi'){
     image(rect,images[8]);rings(uvPoint(rect,.511,.432),56*rect.w/960,t,.38,true);lockBrackets(uvPoint(rect,.511,.432),73*rect.w/960,.27,t);
   }else{
     image(rect,images[9]);finaleEffects(rect,t);
   }
   ctx.restore();
 }
 function transition(from,to,focus,t,start,end,zoom,childScale){
   const raw=clamp01((t-start)/(end-start)),p=smooth(0,1,raw);
   const a=MAP_RECTS[from],b=MAP_RECTS[to],f=uvPoint(a,...focus);
   const focusX=lerp(f.x,b.cx,p),focusY=lerp(f.y,b.cy,p);
   const scale=Math.exp(Math.log(zoom)*p);
   const parent={w:a.w*scale,h:a.h*scale,cx:focusX-(focus[0]-.5)*a.w*scale,cy:focusY-(focus[1]-.5)*a.h*scale};
   const childZoom=Math.exp(lerp(Math.log(childScale),0,p));
   const child={w:b.w*childZoom,h:b.h*childZoom,cx:focusX,cy:focusY};
   drawMap(from,parent,t,1-smooth(.23,.85,p));drawMap(to,child,t,smooth(.18,.83,p));
   ctx.save();ctx.globalCompositeOperation='lighter';
   const amount=Math.sin(raw*Math.PI)*.075;
   const g=ctx.createRadialGradient(focusX,focusY,0,focusX,focusY,180);g.addColorStop(0,`rgba(122,208,255,${amount})`);g.addColorStop(.4,`rgba(41,154,255,${amount*.4})`);g.addColorStop(1,'rgba(18,83,161,0)');ctx.fillStyle=g;ctx.fillRect(focusX-200,focusY-200,400,400);
   if(raw>.22&&raw<.8){ctx.lineWidth=.7;for(const streak of streaks){const r=180+streak.d*500,l=15+Math.sin(raw*Math.PI)*35;ctx.strokeStyle=`rgba(80,177,238,${amount*streak.d})`;ctx.beginPath();ctx.moveTo(focusX+Math.cos(streak.angle)*r,focusY+Math.sin(streak.angle)*r*.65);ctx.lineTo(focusX+Math.cos(streak.angle)*(r+l),focusY+Math.sin(streak.angle)*(r+l)*.65);ctx.stroke();}}
   ctx.restore();
 }
 return {
   resize(next){size=next;for(const c of [backCanvas,effectsCanvas]){c.width=Math.round(size.width*size.dpr);c.height=Math.round(size.height*size.dpr);}},
   draw(t,globeAvailable=true,elapsedSeconds=t){
     referenceSeconds=t;actualSeconds=Number.isFinite(elapsedSeconds)?elapsedSeconds:t;
     background(t);prepare(ctx);ctx.globalAlpha=1;
     if(t<16.2){
       const gs=globeState(t);
       if(!globeAvailable){
         ctx.save();const r=mapRect(806*(1+gs.morph*.12),806,lerp(920,800,gs.morph),442);ctx.translate(r.cx,r.cy);ctx.rotate((1-smooth(0,6.8,t))*(-.11));ctx.translate(-r.cx,-r.cy);image(r,images[1],1-gs.morph);ctx.restore();drawMap('world',MAP_RECTS.world,t,gs.morph);
       }
       if(t>=6.7&&t<9.2){const alpha=smooth(6.7,7.6,t)*(1-smooth(8.65,9.2,t));lockBrackets({x:979,y:366},84,alpha,t);rings({x:979,y:366},78,t,.22*alpha,true);}
       if(t>=15.55)drawMap('world',MAP_RECTS.world,t,smooth(15.55,16.15,t));
     }else if(t<22.8){drawMap('world',MAP_RECTS.world,t);}
     else if(t<26.8){transition('world','china',WORLD_FOCUS,t,22.8,26.8,4.8,.27);}
     else if(t<40.2){drawMap('china',MAP_RECTS.china,t);}
     else if(t<44.2){transition('china','jiangsu',CHINA_FOCUS,t,40.2,44.2,8.8,.17);}
     else if(t<46.4){drawMap('jiangsu',MAP_RECTS.jiangsu,t);}
     else if(t<50.4){transition('jiangsu','wuxi',[.586,.739],t,46.4,50.4,4.8,.24);}
     else if(t<52.5){drawMap('wuxi',MAP_RECTS.wuxi,t);}
     else if(t<56.5){transition('wuxi','huishan',[.511,.432],t,52.5,56.5,3.8,.34);}
     else{const p=smooth(56.5,62,t),r=MAP_RECTS.huishan;drawMap('huishan',{...r,w:r.w*lerp(1,1.065,p),h:r.h*lerp(1,1.065,p),cx:r.cx-13*p,cy:r.cy-5*p},t);}
   },
   dispose(){backCanvas.width=backCanvas.height=effectsCanvas.width=effectsCanvas.height=1;}
 };
}
