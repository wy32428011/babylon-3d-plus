/** 完整循环的踝/前掌后移事件标定；不使用高度分位数，不人为指定支撑占比。 */
export function calibrateFootCycle({name,times,leftFoot,rightFoot,leftToe,rightToe,direction}) {
  const n=times?.length-1,duration=times?.at(-1)-times?.[0],dt=duration/n;
  const length=Math.hypot(direction?.x,direction?.y,direction?.z);
  if(!(n>=8&&duration>0&&Number.isFinite(length)&&length>1e-8)||times.some((t,i)=>!Number.isFinite(t)||Math.abs(t-times[0]-i*dt)>1e-5))throw new Error('接触标定需要完整等距循环时间与有效方向');
  const forward={x:direction.x/length,y:direction.y/length,z:direction.z/length};
  const project=point=>point.x*forward.x+point.y*forward.y+point.z*forward.z;
  const tracks={left:[leftFoot,leftToe],right:[rightFoot,rightToe]},contacts={},speeds=[];
  let phaseOffset=0;
  for(const [side,pair]of Object.entries(tracks)){
    for(const points of pair){
      if(!Array.isArray(points)||points.length!==n+1||points.some(p=>![p?.x,p?.y,p?.z].every(Number.isFinite)))throw new Error(`足部轨迹不完整：${side}`);
      if(Math.hypot(points[0].x-points[n].x,points[0].y-points[n].y,points[0].z-points[n].z)>1e-4)throw new Error(`足部轨迹循环未闭合：${side}`);
    }
    const positions=pair.map(points=>points.slice(0,n).map(project));
    const velocities=positions.map(values=>values.map((_,i)=>(values[(i+1)%n]-values[(i+n-1)%n])/(2*dt)));
    // 步行从踝触地延续到前掌蹬离；跑步要求两点共同后移，允许真实腾空。
    const support=Array.from({length:n},(_,i)=>name.startsWith('Walk')
      ? velocities.some(values=>values[i]<-1e-6)
      : velocities.every(values=>values[i]<-1e-6));
    const starts=support.flatMap((value,i)=>value&&!support[(i+n-1)%n]?[i]:[]);
    if(starts.length===0)throw new Error(`轨迹缺少可分辨的承重/摆动事件：${name}/${side}`);
    for(const start of starts){
      let count=1;while(count<n&&support[(start+count)%n])count++;
      if(count<2)continue;
      // 两个事件均落在相邻帧中点，按完整净后移/时间求速度，不只截取最快的低点样本。
      for(const values of positions){
        const begin=(values[(start+n-1)%n]+values[start])/2;
        const end=(values[(start+count-1)%n]+values[(start+count)%n])/2;
        const speed=(begin-end)/(count*dt);
        if(speed>1e-6&&Number.isFinite(speed))speeds.push(speed);
      }
    }
    const curve=support.map((value,i)=>(Number(support[(i+n-1)%n])+2*Number(value)+Number(support[(i+1)%n]))/4);
    contacts[side]=[...curve,curve[0]];
    if(side==='left')phaseOffset=starts[0]/n;
  }
  if(!speeds.length)throw new Error('动作没有有效承重位移，无法标定步长');
  speeds.sort((a,b)=>a-b);
  const middle=Math.floor(speeds.length/2),referenceSpeed=speeds.length%2?speeds[middle]:(speeds[middle-1]+speeds[middle])/2;
  return {referenceSpeed,cycleDistanceMeters:referenceSpeed*duration,phaseOffset,contacts,
    calibration:'cyclic-ankle-toe-rearward-events-full-support-displacement-median-v1'};
}
