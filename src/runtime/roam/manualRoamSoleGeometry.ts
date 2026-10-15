import { Matrix, Vector3, VertexBuffer, type AssetContainer, type TransformNode } from '@babylonjs/core';

export type ManualRoamSoleGeometry={points:Vector3[];sample:()=>Vector3[]};

/** 仅初始化扫描独立鞋网格；缓存有界蒙皮点，逐帧不读取顶点缓冲区。 */
export function measureManualRoamSole(container: AssetContainer, foot: TransformNode, side: string, fallbackHeight: number): ManualRoamSoleGeometry {
  const local: Vector3[]=[];
  const samples:{influences:{point:Vector3;weight:number;node:TransformNode}[]}[]=[];
  container.skeletons.forEach(skeleton=>skeleton.prepare(true));
  const inverse=Matrix.Invert(foot.computeWorldMatrix(true));
  for(const mesh of container.meshes) {
    const skeleton=mesh.skeleton,indices=mesh.getIndices();
    if(!skeleton||!indices||mesh.getTotalVertices()>50000)continue;
    const joints=mesh.getVerticesData(VertexBuffer.MatricesIndicesKind),weights=mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    if(!joints||!weights)continue;
    const vertices=[...new Set(indices)],weight=(i:number,prefix:string)=>{
      let sum=0;for(let k=0;k<4;k++)if(new RegExp(`^${prefix}(Foot|ToeBase)$`).test(skeleton.bones[joints[i*4+k]]?.name??''))sum+=weights[i*4+k];return sum;
    };
    const shoe=mesh.material?.name==='Ren_Xie_M'||vertices.reduce((sum,i)=>sum+weight(i,'(Left|Right)'),0)/vertices.length>0.7;
    if(!shoe)continue;
    const positions=mesh.getPositionData(true),original=mesh.getVerticesData(VertexBuffer.PositionKind);if(!positions||!original)continue;
    const toFoot=mesh.computeWorldMatrix(true).multiply(inverse);
    for(const i of vertices) {
      let sideWeight=0;for(let k=0;k<4;k++)if(skeleton.bones[joints[i*4+k]]?.name.startsWith(side))sideWeight+=weights[i*4+k];
      if(sideWeight<=.5)continue;
      local.push(Vector3.TransformCoordinates(Vector3.FromArray(positions,i*3),toFoot));
      const influences=[];
      for(let k=0;k<4;k++) {
        if(weights[i*4+k]<=1e-8)continue;
        const bone=skeleton.bones[joints[i*4+k]],node=bone?.getTransformNode();
        if(node)influences.push({point:Vector3.TransformCoordinates(Vector3.FromArray(original,i*3),bone.getAbsoluteInverseBindMatrix()),weight:weights[i*4+k],node});
      }
      samples.push({influences});
    }
  }
  if(!local.length){const points=[new Vector3(0,-fallbackHeight,0)];return {points,sample:()=>points};}
  const selected=new Set<Vector3>();
  for(let latitude=0;latitude<=6;latitude++)for(let longitude=0;longitude<8;longitude++){
    const pitch=-Math.PI/2+latitude*Math.PI/6,yaw=longitude*Math.PI/4,direction=new Vector3(Math.cos(pitch)*Math.cos(yaw),Math.sin(pitch),Math.cos(pitch)*Math.sin(yaw));
    selected.add(local.reduce((best,point)=>Vector3.Dot(point,direction)<Vector3.Dot(best,direction)?point:best));
  }
  const points=[...selected].map(point=>point.clone());
  // 默认人物每鞋不足512点。缓存权重及bind局部坐标后按当前关节求值，避免趾骨屈伸令刚性鞋底预测失真。
  if(samples.length>2048||samples.some(sample=>Math.abs(sample.influences.reduce((sum,item)=>sum+item.weight,0)-1)>1e-4))return {points,sample:()=>points};
  return {points,sample:()=>{
    const matrices=new Map<TransformNode,Matrix>(),footInverse=Matrix.Invert(foot.computeWorldMatrix(true));
    for(const sample of samples)for(const item of sample.influences)if(!matrices.has(item.node))matrices.set(item.node,item.node.computeWorldMatrix(true).clone());
    return samples.map(sample=>{const world=Vector3.Zero();for(const item of sample.influences)world.addInPlace(Vector3.TransformCoordinates(item.point,matrices.get(item.node)!).scale(item.weight));return Vector3.TransformCoordinates(world,footInverse);});
  }};
}
