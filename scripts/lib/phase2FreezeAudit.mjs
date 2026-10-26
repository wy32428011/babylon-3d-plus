/**
 * 只读冻结覆盖审计。所有依赖都在函数内，可把函数源码交给 page.evaluate。
 * 安全候选仅来自现有受控静态环境会话；当前不动、没有动画或名字像静态都不是所有权证明。
 */
export function collectPhase2FreezeAudit({ scene, runtime = null, detailLimit = 256 }) {
  if (!scene || !Array.isArray(scene.meshes)) throw new TypeError('冻结审计需要真实 scene.meshes 数组');
  const limit = Number.isSafeInteger(detailLimit) && detailLimit >= 0 ? Math.min(detailLimit, 10000) : 256;
  const meshes = [...scene.meshes], parentsWithChildren = new Set(), animatedTargets = new Set();
  const roots = new Map();
  const environment = runtime?.environment?.environmentRuntime ?? runtime?.environmentRuntime ?? null;
  const environmentEntry = environment?.current ?? null;
  const environmentMeshes = new Set(environmentEntry?.container?.meshes ?? []);
  const environmentRoot = environmentEntry?.root ?? null;
  const controlledEnvironment = Boolean(environmentEntry && !environmentEntry.disposed && environmentEntry.controlledTransforms
    && !environment?.pending && !environment?.adjustmentActive);
  const values = map => map instanceof Map ? [...map.values()] : [];
  const models = values(runtime?.assets?.models);
  const unrestrictedScriptOwners = new Set();
  for (const model of models) {
    if (model?.root) roots.set(model.root, { kind: 'model', model });
    if (model?.contentRoot) roots.set(model.contentRoot, { kind: 'model', model });
    if (model?.entitySnapshot?.components?.modelAsset?.scriptAssets?.length || model?.externalScriptRuntime) unrestrictedScriptOwners.add(model);
  }
  for (const map of [runtime?.outputs?.spawnedDeviceModels, runtime?.outputs?.generatedOutputOwners]) {
    for (const output of values(map)) {
      if (output?.root) roots.set(output.root, { kind: 'generated', model: output });
      if (output?.entitySnapshot?.components?.modelAsset?.scriptAssets?.length || output?.externalScriptRuntime) unrestrictedScriptOwners.add(output);
    }
  }
  let setupInspectionErrors = 0;
  for (const node of [...meshes, ...(scene.transformNodes ?? []), ...(scene.lights ?? []), ...(scene.cameras ?? [])]) {
    try {
      if (node?.parent) parentsWithChildren.add(node.parent);
      if (node?.metadata?.script || node?.metadata?.scripts?.length) unrestrictedScriptOwners.add(node);
    } catch { setupInspectionErrors++; }
  }
  if (scene.metadata?.script || scene.metadata?.scripts?.length) unrestrictedScriptOwners.add(scene);
  for (const group of [...(scene.animationGroups ?? []), ...(environmentEntry?.container?.animationGroups ?? [])]) {
    for (const animation of group?.targetedAnimations ?? []) if (animation?.target) animatedTargets.add(animation.target);
  }
  for (const animation of scene._activeAnimatables ?? []) if (animation?.target) animatedTargets.add(animation.target);
  const summary = { total: meshes.length, frozen: 0, unfrozen: 0, disposed: 0,
    eligible: 0, eligibleAlreadyFrozen: 0, eligibleUnfrozen: 0, inspectionErrors: setupInspectionErrors };
  const byOwner = {}, rejectionReasons = {}, flags = {}, rows = [];
  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index], reasons = new Set(), observed = new Set();
    let owner = 'unknown', frozen = false, disposed = false;
    try {
      if (setupInspectionErrors > 0) reasons.add('incompleteStructureInspection');
      frozen = mesh.isWorldMatrixFrozen === true;
      disposed = mesh._nodeDataStorage?._isDisposed === true;
      if (disposed) reasons.add('disposed');
      const vertexCount = mesh.geometry?._totalVertices;
      if (typeof vertexCount !== 'number' || !Number.isFinite(vertexCount)) reasons.add('geometryNotInspectable');
      else if (vertexCount <= 0) reasons.add('emptyGeometry');
      if (parentsWithChildren.has(mesh)) reasons.add('nonLeaf');
      if (mesh.isAnInstance === true) { observed.add('nativeInstance'); reasons.add('instanceOwnership'); }
      if ((mesh.instances?.length ?? 0) > 0) { observed.add('instanceSource'); reasons.add('instanceOwnership'); }
      if ((mesh.thinInstanceCount ?? 0) > 0) { observed.add('thinInstances'); reasons.add('instanceOwnership'); }
      const visited = new Set();
      let modelOwner = null, foundEnvironmentRoot = false, depth = 0;
      for (let node = mesh; node; node = node.parent) {
        if (visited.has(node)) { reasons.add('parentCycle'); break; }
        if (++depth > 128) { reasons.add('parentDepthLimit'); break; }
        visited.add(node);
        if (node === environmentRoot) {
          foundEnvironmentRoot = true;
          if (node.parent) reasons.add('unknownAncestorOwnership');
        }
        modelOwner ??= roots.get(node) ?? null;
        if (animatedTargets.has(node)) { observed.add('animationTarget'); reasons.add('animatedAncestry'); }
        if ((node.animations?.length ?? 0) > 0) { observed.add('animation'); reasons.add('animatedAncestry'); }
        if (node.billboardMode && node.billboardMode !== 0) { observed.add('billboard'); reasons.add('dynamicPresentation'); }
        if (node.infiniteDistance === true) { observed.add('infiniteDistance'); reasons.add('dynamicPresentation'); }
        for (const [key, flag] of [['skeleton', 'skeleton'], ['morphTargetManager', 'morph'],
          ['bakedVertexAnimationManager', 'bakedAnimation'], ['actionManager', 'action']]) {
          if (node[key]) { observed.add(flag); reasons.add('mutableAncestry'); }
        }
        const metadata = node.metadata;
        if (metadata && (metadata.runtimeDynamic || metadata.motionSourceNodeName || metadata.dataDriven)) {
          observed.add('runtimeMotion'); reasons.add('dynamicMetadata');
        }
        if (metadata && (metadata.script || metadata.scripts?.length)) { observed.add('externalScript'); reasons.add('externalScript'); }
        if (metadata?.editorStaticWorldMatrix === false) reasons.add('explicitDynamic');
        const scale = node.scaling;
        if (scale) {
          if (![scale.x, scale.y, scale.z].every(Number.isFinite)) reasons.add('invalidScale');
          if (scale.x * scale.y * scale.z < 0) observed.add('negativeDeterminantScale');
          if (scale.x !== scale.y || scale.y !== scale.z) observed.add('nonUniformScale');
        }
        if (node.parent && (!node.parent.position || !node.parent.scaling)) reasons.add('unsupportedParentShape');
      }
      if (modelOwner) {
        owner = modelOwner.kind;
        const component = modelOwner.model.entitySnapshot?.components;
        const asset = component?.modelAsset;
        if (asset?.scriptAssets?.length || modelOwner.model.externalScriptRuntime) {
          observed.add('externalScript'); reasons.add('externalScript');
        }
        if (component?.telemetryBinding?.enabled) { observed.add('telemetry'); reasons.add('telemetry'); }
        reasons.add(modelOwner.kind === 'generated' ? 'generatedOwnership' : 'modelNotCertifiedStatic');
      } else if (environmentMeshes.has(mesh) && foundEnvironmentRoot) {
        owner = 'environment';
        if (!controlledEnvironment) reasons.add('environmentNotControlledOrSettled');
        // 未实施能力声明前，不能由宿主归属推断其它脚本不会修改环境。
        if (unrestrictedScriptOwners.size > 0) reasons.add('unboundedExternalScriptAccess');
      } else reasons.add('unknownOwnership');
    } catch {
      reasons.add('inspectionError'); summary.inspectionErrors++;
    }
    if (frozen) summary.frozen++; else summary.unfrozen++;
    if (disposed) summary.disposed++;
    byOwner[owner] = (byOwner[owner] ?? 0) + 1;
    const eligible = reasons.size === 0 && owner === 'environment';
    if (eligible) {
      summary.eligible++;
      if (frozen) summary.eligibleAlreadyFrozen++; else summary.eligibleUnfrozen++;
    }
    for (const reason of reasons) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    for (const flag of observed) flags[flag] = (flags[flag] ?? 0) + 1;
    if (rows.length < limit) rows.push({ meshIndex: index, name: String(mesh?.name ?? '').slice(0, 160), owner, frozen,
      eligible, reasons: [...reasons].sort(), flags: [...observed].sort() });
  }
  return { scope: 'read-only-current-runtime-freeze-coverage', policy: 'controlled-environment-leaves-only; unknown ownership or mutability rejected',
    summary, byOwner, rejectionReasons, flags, unrestrictedScriptOwnerCount: unrestrictedScriptOwners.size,
    rows, detailsTruncated: meshes.length > rows.length,
    limitations: ['existing frozen but conservatively rejected does not prove a product defect',
      'negative/non-uniform scale is reported, not itself proof of mutability',
      'no world-matrix computation, freeze/unfreeze, lighting collection or scene mutation is performed'] };
}
