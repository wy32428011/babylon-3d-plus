/** 固定来源人物的衣身与袖子是独立拓扑片；空间相邻不能作为共同绑臂的依据。 */
export function identifyShirtBodyVertices(vertices, triangles, names, joints) {
  const neighbors = new Map();
  for (let i = 0; i < triangles.length; i += 3) {
    const face = triangles.slice(i, i + 3);
    for (const vertex of face) {
      if (!neighbors.has(vertex)) neighbors.set(vertex, new Set());
      for (const other of face) neighbors.get(vertex).add(other);
    }
  }
  const hip = joints[names.indexOf('Hips')];
  const shoulders = ['LeftArm', 'RightArm'].map(name => joints[names.indexOf(name)]);
  const halfWidth = Math.max(...shoulders.map(p => Math.abs(p.x - hip.x)));
  const shoulderHeight = Math.min(...shoulders.map(p => p.y));
  const remaining = new Set(neighbors.keys()), body = new Set();
  let panels = 0;
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const queue = [seed], component = [];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    while (queue.length) {
      const index = queue.pop(), p = vertices[index];
      component.push(index);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minX = Math.min(minX, p.x - hip.x); maxX = Math.max(maxX, p.x - hip.x);
      for (const next of neighbors.get(index)) if (remaining.delete(next)) queue.push(next);
    }
    // 衣身从腰部延伸至领口并接近中线；袖片和肩片分别不满足中线或腰部条件。
    const reachesCenter = minX < halfWidth * .2 && maxX > -halfWidth * .2;
    const width = maxX - minX;
    if (minY < hip.y + .06 && maxY > shoulderHeight + .04 && reachesCenter
      && width > halfWidth * .6 && Math.max(Math.abs(minX), Math.abs(maxX)) < halfWidth * 1.1) {
      component.forEach(index => body.add(index));
      panels++;
    }
  }
  // 上游已锁定原始GLB指纹；结构异常时拒绝静默退回空间距离绑骨。
  if (panels !== 2) throw new Error(`衣身拓扑识别异常：预期左右两片，实际 ${panels}。`);
  // 材质内部的UV/法线分片也有重合接边；同步对应点，而不是焊接几何或把整条袖子纳入衣身。
  const positionKey = index => vertices[index].asArray().join(',');
  const bodyPositions = new Set([...body].map(positionKey));
  for (const index of neighbors.keys()) if (bodyPositions.has(positionKey(index))) body.add(index);
  return body;
}

/** 只迁移衣身误绑的手臂权重，保留原躯干权重比例与肩部过渡；袖子不调用此函数。 */
export function constrainShirtBodyWeights(position, ranked, torsoFallback, names, joints) {
  const shoulderHeight = Math.min(...['LeftArm', 'RightArm'].map(name => joints[names.indexOf(name)].y));
  const t = Math.max(0, Math.min(1, (position.y - (shoulderHeight - .15)) / .15));
  const retention = t * t * (3 - 2 * t);
  const isArm = index => /Shoulder|Arm|Hand/.test(names[index]);
  const armWeight = ranked.reduce((sum, item) => sum + (isArm(item.index) ? item.raw : 0), 0);
  if (retention >= 1 || armWeight <= 0) return ranked;
  const existingTorso = ranked.filter(item => ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck'].includes(names[item.index]));
  // 原空间分类可能完全排除了躯干；此时用实际躯干骨段距离重建分配，不能归一化空权重。
  const torso = existingTorso.length ? existingTorso : torsoFallback;
  const total = torso.reduce((sum, item) => sum + item.raw, 0);
  if (!(total > 0)) throw new Error('衣身没有有效躯干权重。');
  const result = ranked.map(item => ({ ...item, raw: item.raw * (isArm(item.index) ? retention : 1) }));
  for (const item of torso) {
    const extra = armWeight * (1 - retention) * item.raw / total;
    const existing = result.find(value => value.index === item.index);
    if (existing) existing.raw += extra;
    else result.push({ index: item.index, raw: extra });
  }
  return result.filter(item => item.raw > 0);
}
