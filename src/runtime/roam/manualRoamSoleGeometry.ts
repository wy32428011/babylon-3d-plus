import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AbstractMesh, AssetContainer, TransformNode } from '@babylonjs/core';

export type ManualRoamSoleGeometry={points:Vector3[];sample:()=>Vector3[]};
export type ManualRoamSoleOptions = { joints?: ReadonlyMap<string, TransformNode>; automatic?: boolean };

type SkinPoint = { point: Vector3; influences: { index: number; weight: number }[] };
const MAX_AUTOMATIC_SOLE_POINTS = 16_384;

/** 全部候选足部点进入缓存；超出精确采样预算明确降级，不能悄悄改成默认鞋底或裁剪原网格。 */
function measureAutomaticSole(container: AssetContainer, foot: TransformNode): ManualRoamSoleGeometry {
  const groups: { mesh: AbstractMesh; points: SkinPoint[] }[] = [];
  let count = 0;
  for (const mesh of container.meshes) {
    const skeleton = mesh.skeleton;
    if (!skeleton || !mesh.getTotalVertices()) continue;
    const footIndices = new Set(skeleton.bones.filter(bone => {
      const node = bone.getTransformNode();
      return node === foot || node?.isDescendantOf(foot);
    }).map(bone => bone.getIndex()).filter(index => index >= 0));
    if (!footIndices.size) continue;
    const ids = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind), weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    const extraIds = mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind), extraWeights = mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!ids || !weights || !positions) throw new Error('足底缺少有效的蒙皮顶点数据。');
    const extras = mesh.numBoneInfluencers > 4;
    if (mesh.numBoneInfluencers > 8 || (extras && (!extraIds || !extraWeights))) throw new Error('足底蒙皮影响数据不完整，暂不支持精确贴地。');
    const points: SkinPoint[] = [], visited = new Uint8Array(mesh.getTotalVertices());
    const indices = mesh.getIndices(), vertexCount = indices?.length ?? mesh.getTotalVertices();
    for (let at = 0; at < vertexCount; at++) {
      const i = indices ? indices[at] : at;
      if (visited[i]) continue;
      visited[i] = 1;
      let footWeight = 0;
      const influences: SkinPoint['influences'] = [];
      for (let k = 0; k < (extras ? 8 : 4); k++) {
        const index = k < 4 ? ids[i * 4 + k] : extraIds![i * 4 + k - 4];
        const weight = k < 4 ? weights[i * 4 + k] : extraWeights![i * 4 + k - 4];
        if (!Number.isFinite(weight) || weight < 0) throw new Error('足底蒙皮权重无效。');
        if (weight <= 0) continue;
        if (!Number.isInteger(index) || index < 0 || index >= skeleton.bones.length) throw new Error('足底蒙皮骨骼索引无效。');
        influences.push({ index, weight });
        if (footIndices.has(index)) footWeight += weight;
      }
      if (footWeight <= .5) continue;
      const sum = influences.reduce((value, item) => value + item.weight, 0);
      if (Math.abs(sum - 1) > 1e-3) throw new Error('足底蒙皮权重未归一化，暂不支持精确贴地。');
      const point = Vector3.FromArray(positions, i * 3);
      if (!point.asArray().every(Number.isFinite)) throw new Error('足底顶点坐标无效。');
      // 同一网格可有面部表情；只拒绝会改变足底的形态，避免缓存静态位置后错误贴地。
      const morphs = mesh.morphTargetManager;
      for (let target = 0; target < (morphs?.numTargets ?? 0); target++) {
        const morphed = morphs!.getTarget(target).getPositions();
        if (morphed && Vector3.DistanceSquared(point,Vector3.FromArray(morphed,i*3)) > 1e-12) throw new Error('足底带有形态变形，暂不支持精确贴地。');
      }
      if (++count > MAX_AUTOMATIC_SOLE_POINTS) throw new Error(`足底精确采样超过 ${MAX_AUTOMATIC_SOLE_POINTS} 个顶点，保留基础动作。`);
      points.push({ point, influences });
    }
    if (points.length) groups.push({ mesh, points });
  }
  if (count < 3) throw new Error('无法从蒙皮找到可靠的足底轮廓，保留基础动作。');
  const sample = (): Vector3[] => {
    const result: Vector3[] = [], footInverse = Matrix.Invert(foot.computeWorldMatrix(true));
    const matrix = Matrix.Identity(), blended = Matrix.Zero();
    const prepared = new Set<object>();
    for (const { mesh, points } of groups) {
      const skeleton = mesh.skeleton!;
      if (!prepared.has(skeleton)) { skeleton.prepare(true); prepared.add(skeleton); }
      const matrices = skeleton.getTransformMatrices(mesh), toFoot = mesh.computeWorldMatrix(true).multiply(footInverse);
      for (const point of points) {
        blended.reset();
        for (const influence of point.influences) {
          Matrix.FromFloat32ArrayToRefScaled(matrices, influence.index * 16, influence.weight, matrix);
          blended.addToSelf(matrix);
        }
        result.push(Vector3.TransformCoordinates(Vector3.TransformCoordinates(point.point, blended), toFoot));
      }
    }
    return result;
  };
  return { points: sample(), sample };
}

/** 仅初始化扫描独立鞋网格；缓存有界蒙皮点，逐帧不读取顶点缓冲区。 */
export function measureManualRoamSole(container: AssetContainer, foot: TransformNode, side: string, fallbackHeight: number, options: ManualRoamSoleOptions = {}): ManualRoamSoleGeometry {
  if (options.automatic) return measureAutomaticSole(container, foot);
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
