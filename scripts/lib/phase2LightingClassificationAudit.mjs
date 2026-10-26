/* global window, document */

/** 只连接本次窗口的真实React ref；不触发查询、捕获或额外失效。 */
export function installClassificationAudit({ arm }) {
  if (!['A', 'B'].includes(arm)) throw new Error('未知arm');
  const root = document.getElementById('root'), key = Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = root?.[key], pending = first ? [first.stateNode?.current ?? first] : [], visited = new Set();
  let runtime;
  const visit = value => { const candidate = value?.current ?? value;
    if (candidate?.scene?.meshes && !candidate.scene.isDisposed && typeof candidate.getPerformanceMetrics === 'function') runtime = candidate; };
  while (pending.length && visited.size < 30000) {
    const fiber = pending.pop(); if (!fiber || visited.has(fiber)) continue; visited.add(fiber);
    for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState; for (let index = 0; hook && index < 500; index++, hook = hook.next) visit(hook.memoizedState);
    pending.push(fiber.child, fiber.sibling);
  }
  const lighting = runtime?.environment?.lightingRuntime;
  if (!lighting || typeof lighting.options?.getSources !== 'function' || typeof lighting.hasClassificationConsumer !== 'function'
    || typeof lighting.tick !== 'function' || typeof lighting.refreshSources !== 'function') throw new Error('真实SceneRuntime/SceneLightingRuntime对象结构不符，不能替换成模拟对象。');
  const options = lighting.options, originalConsumer = lighting.hasClassificationConsumer;
  const originalCoalesce = Object.getOwnPropertyDescriptor(options, 'classificationCoalesceMinMs');
  if (originalCoalesce && originalCoalesce.value !== 250) throw new Error('B原配置不是缺省/250ms，停止而不改变条件。');
  const restored = [], state = { runtime, lighting, arm, active: null, source: {}, originalConsumer,
    originalCoalesce: originalCoalesce ? originalCoalesce.value : 'absent-default-250', restores: restored };
  const own = (object, name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, { value, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false });
    restored.push(() => { if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name]; });
  };
  for (const [object, name, label] of [[options, 'getSources', 'getSources'], [lighting, 'tick', 'tick'], [lighting, 'refreshSources', 'refreshSources']]) {
    const original = object[name];
    own(object, name, function (...args) {
      const active = state.active; if (!active) return Reflect.apply(original, this, args);
      const withinTick = (active.tickDepth ?? 0) > 0;
      if (label === 'tick') active.tickDepth = (active.tickDepth ?? 0) + 1;
      const start = performance.now(); let failed = false;
      try { return Reflect.apply(original, this, args); } catch (error) { failed = true; throw error; }
      finally { const elapsed = performance.now() - start, row = active.calls[label]; row.count++; row.totalMs += elapsed;
        row.maxMs = Math.max(row.maxMs, elapsed); if (failed) row.failures++; if (withinTick) row.withinTickMs += elapsed;
        row.raw.push({ atMs: start - active.started, durationMs: elapsed, failed, withinTick });
        if (label === 'tick') active.tickDepth--; }
    });
  }
  if (arm === 'A') { own(options, 'classificationCoalesceMinMs', 0); own(lighting, 'hasClassificationConsumer', () => true); }
  else if (arm !== 'B') throw new Error('未知arm');
  state.describe = () => ({ arm, originalCoalesce: state.originalCoalesce,
    effectiveCoalesce: options.classificationCoalesceMinMs ?? 250,
    originalConsumer: Reflect.apply(originalConsumer, lighting, []), effectiveConsumer: lighting.hasClassificationConsumer(),
    ownConsumerOverride: Object.hasOwn(lighting, 'hasClassificationConsumer'),
    noForcedInvalidation: true, error: lighting.getError(), stateActive: Boolean(lighting.state),
    runtime: runtime.getPerformanceMetrics(), initial: runtime.getInitialLoadSnapshot() });
  state.describeEditing = () => ({ telemetryPreviewActive: runtime.telemetry?.telemetryPreviewActive,
    fetchConfigSnapshotSet: runtime.fetch?.fetchConfigSnapshot !== null, fetchSyncTimerActive: runtime.fetch?.fetchSyncTimer !== null,
    fetchInFlightOperations: runtime.fetch?.fetchInFlightOperations });
  state.restore = () => { state.active = null; for (const restore of restored.reverse()) restore(); };
  window.__phase2ClassificationAudit = state;
  return state.describe();
}

/** 准入/末尾功能窗口读取既有状态与资源数量；正式60s不会调用，也不触发分类或资源同步。 */
export function readClassificationReadyReceipt(expected) {
  if(window.__phase2ClassificationAudit?.active)throw new Error('CLASSIFICATION_READY_READ_FORBIDDEN_DURING_PERFORMANCE');
  const runtime=window.__phase2ClassificationAudit?.runtime;
  if(!runtime)throw new Error('CLASSIFICATION_READY_RUNTIME_UNAVAILABLE');
  const root=document.getElementById('root'),key=Object.keys(root??{}).find(name=>name.startsWith('__reactContainer$'));
  const first=root?.[key],pending=first?[first.stateNode?.current??first]:[],visited=new Set(),preparations=new Set();
  while(pending.length&&visited.size<30000){
    const fiber=pending.pop();if(!fiber||visited.has(fiber))continue;visited.add(fiber);let hook=fiber.memoizedState;
    for(let index=0;hook&&index<500;index++,hook=hook.next){
      const value=hook.memoizedState;
      if(value&&typeof value==='object'&&typeof value.sceneSessionId==='string'&&value.runtime&&typeof value.phase==='string'
        &&typeof hook.queue?.getSnapshot==='function'){
        const current=hook.queue.getSnapshot();if(current&&typeof current.sceneSessionId==='string'&&current.runtime&&typeof current.phase==='string')preparations.add(current);
      }
    }
    pending.push(fiber.child,fiber.sibling);
  }
  if(preparations.size!==1)throw new Error('CLASSIFICATION_PREPARATION_STATE_UNAVAILABLE_OR_AMBIGUOUS:'+preparations.size);
  const preparation=[...preparations][0],models=runtime.assets?.models,instances=runtime.arrays?.modelArrayInstanceEntities;
  if(Object.prototype.toString.call(models)!=='[object Map]'||Object.prototype.toString.call(instances)!=='[object Map]')throw new Error('CLASSIFICATION_MODEL_RESOURCE_MAP_UNAVAILABLE');
  const metrics=runtime.getPerformanceMetrics(),initial=runtime.getInitialLoadSnapshot(),errors=[];
  for(const id of expected.entityIds){const error=runtime.getModelReadinessError(id);if(error)errors.push({entityId:id,error:String(error).slice(0,4096)});}
  const environmentRuntime=runtime.environment?.environmentRuntime;
  if(typeof environmentRuntime?.getSnapshot!=='function')throw new Error('CLASSIFICATION_ENVIRONMENT_SNAPSHOT_UNAVAILABLE');
  const environment=environmentRuntime.getSnapshot(),entry=environmentRuntime.current;
  let actualEnvironment=null;
  if(expected.environment){
    if(!Array.isArray(entry?.renderMeshes))throw new Error('CLASSIFICATION_ENVIRONMENT_RENDER_MESHES_UNAVAILABLE');
    const sceneMeshes=new Set(runtime.scene.meshes);let vertices=0,triangles=0;const invalid=[];
    for(const mesh of entry.renderMeshes){
      if(!sceneMeshes.has(mesh)||mesh.isDisposed()||mesh.getTotalVertices()<=0||mesh.metadata?.editorEnvironmentMesh!==true)invalid.push(mesh.name);
      const multiplier=mesh.thinInstanceCount>0?mesh.thinInstanceCount:1,vertexCount=mesh.getTotalVertices(),indexCount=mesh.getTotalIndices();
      vertices+=vertexCount*multiplier;triangles+=Math.floor(((mesh.sourceMesh??mesh).isUnIndexed?vertexCount:indexCount>0?indexCount:vertexCount)/3)*multiplier;
    }
    actualEnvironment={meshCount:entry.renderMeshes.length,vertexCount:vertices,triangleCount:triangles,invalidMeshes:invalid};
  }
  return {sceneId:runtime.document?.shadowDocument?.id??null,metrics,initial,modelErrors:errors,
    modelIds:[...models.keys()].sort(),instanceIds:[...instances.keys()].sort(),readyModelIds:expected.modelIds.filter(id=>runtime.isModelReady(id)).sort(),
    environment,actualEnvironment,skybox:runtime.getSkyboxReadiness(),
    preparationState:{sceneSessionId:preparation.sceneSessionId,phase:preparation.phase,completed:preparation.completed,modelSyncStatus:preparation.modelSyncStatus,
      assetRefreshStatus:preparation.assetRefreshStatus,modelSyncProgress:preparation.modelSyncProgress,warnings:preparation.warnings,runtime:{...preparation.runtime}},
    hudVisible:Boolean(document.querySelector('.scene-performance-hud')),resourceIssue:document.querySelector('aside[aria-label="场景资源状态"]')?.textContent??null};
}

/** 正式性能窗口没有像素、几何、世界矩阵或全量性能快照读取。 */
export function measureClassificationWindow({ durationMs = 60000 }) {
  const audit = window.__phase2ClassificationAudit, { runtime, lighting } = audit, scene = runtime.scene, engine = scene.getEngine();
  if (audit.active) throw new Error('已有性能窗口');
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw new Error('LongTask unavailable；不能用0冒充。');
  const counter = () => ({ count: 0, totalMs: 0, maxMs: 0, failures: 0, withinTickMs: 0, raw: [] });
  const previousDiagnosticEnabled = lighting.getInvalidationDiagnostics().enabled;
  lighting.setInvalidationDiagnosticsEnabled(true); lighting.resetInvalidationDiagnostics();
  const started = performance.now(), active = { started, calls: { getSources: counter(), tick: counter(), refreshSources: counter() } };
  const size = [engine.getRenderWidth(), engine.getRenderHeight()], meshCount = scene.meshes.length, frames = [], longtasks = [], invalid = new Set();
  const resourceStart = performance.getEntriesByType('resource').length;
  const observer = new PerformanceObserver(list => { for (const item of list.getEntries()) if (item.startTime >= started) longtasks.push(item.toJSON()); });
  observer.observe({ type: 'longtask', buffered: false }); audit.active = active;
  return new Promise(resolve => {
    const frameObserver = engine.onEndFrameObservable.add(() => {
      frames.push(performance.now() - started);
      if (document.visibilityState !== 'visible' || !document.hasFocus()) invalid.add('hidden-or-unfocused');
      if (engine.getRenderWidth() !== size[0] || engine.getRenderHeight() !== size[1]) invalid.add('drawing-buffer-changed');
      if (scene.meshes.length !== meshCount) invalid.add('mesh-count-changed');
      if (runtime.telemetry?.telemetryPreviewActive !== false || runtime.fetch?.fetchSyncTimer !== null
        || runtime.fetch?.fetchConfigSnapshot !== null || runtime.fetch?.fetchInFlightOperations !== 0) invalid.add('not-idle-editor-editing-fetch-state');
    });
    setTimeout(() => {
      const ended = performance.now(); audit.active = null; engine.onEndFrameObservable.remove(frameObserver);
      for (const item of observer.takeRecords()) if (item.startTime >= started) longtasks.push(item.toJSON()); observer.disconnect();
      const diagnostics = lighting.getInvalidationDiagnostics(); lighting.setInvalidationDiagnosticsEnabled(previousDiagnosticEnabled);
      const frameIntervalsMs = frames.slice(1).map((at, index) => at - frames[index]);
      const resourcesAdded = performance.getEntriesByType('resource').slice(resourceStart).map(item => ({ name: item.name, startTime: item.startTime, duration: item.duration }));
      if (resourcesAdded.length) invalid.add('new-resource-timing-entry');
      if (ended - started < durationMs || ended - started > durationMs + 3000) invalid.add('elapsed-outside-60-to-63-seconds');
      if (frameIntervalsMs.length < 300) invalid.add('fewer-than-300-frame-intervals');
      if (lighting.getError()) invalid.add('lighting-runtime-error');
      for (const value of Object.values(active.calls)) if (value.failures) invalid.add('instrumented-call-failed');
      resolve({ elapsedMs: ended - started, size, meshCount, frameAtMs: frames, frameIntervalsMs,
        longtasks, longtasksSupported: true, calls: active.calls, diagnostics, resourcesAdded,
        invalidReasons: [...invalid], measurementValid: invalid.size === 0,
        basis: 'inclusive same-instance wrappers; tick/refreshSources/getSources overlap and must not be summed; engine frame intervals are CPU cadence, not GPU timer samples' });
    }, durationMs);
  });
}

/** 独立功能窗口：完整RGBA与全部实际几何/矩阵指纹，不在正式性能窗口调用。 */
export async function captureClassificationFunction() {
  const audit = window.__phase2ClassificationAudit;
  if (audit.active) throw new Error('禁止在正式性能窗口同步readPixels/读取几何');
  const scene = audit.runtime.scene, engine = scene.getEngine();
  if (typeof window.crypto?.subtle?.digest !== 'function' || typeof window.btoa !== 'function' || typeof TextEncoder !== 'function') {
    throw new Error('CLASSIFICATION_CAPTURE_BROWSER_API_UNAVAILABLE: crypto.subtle.digest/btoa/TextEncoder');
  }
  if (typeof engine._gl?.readPixels !== 'function') throw new Error('CLASSIFICATION_CAPTURE_BROWSER_API_UNAVAILABLE: WebGL readPixels');
  const hash = async bytes => Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
  const asBytes = array => {
    if (ArrayBuffer.isView(array)) return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    if (Object.prototype.toString.call(array) === '[object ArrayBuffer]') return new Uint8Array(array);
    if (!Array.isArray(array)) throw new Error('未知几何数组类型');
    if (array.length * 8 > 128 * 1024 ** 2) throw new Error('单个功能指纹数组超过128MiB工具预算');
    return new Uint8Array(new Float64Array(array).buffer);
  };
  const base64 = bytes => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return window.btoa(text); };
  const initial = await new Promise((resolve, reject) => scene.onAfterRenderObservable.addOnce(() => {
    try {
      const frameId=scene.getFrameId(),startedAt=performance.now(),geometries=new Map(),buffers=new Map(),gpuBuffers=new Map();
      let frozenGeometryBytes=0,trajectoryBytes=0,gpuReadbackBytes=0;
      const freezeBuffer=(identity,values)=>{
        const existing=buffers.get(identity);
        if(existing){if(existing.reference!==values)throw new Error('CLASSIFICATION_CAPTURE_BUFFER_CHANGED_DURING_SYNC_SNAPSHOT');return existing.packet;}
        const bytes=asBytes(values);if(bytes.length>128*1024**2)throw new Error('单个实际几何属性超过128MiB工具预算');
        const packet={bytes:new Uint8Array(bytes)};buffers.set(identity,{reference:values,packet});frozenGeometryBytes+=bytes.length;return packet;
      };
      const freezeMatrix=values=>{const bytes=asBytes(values);trajectoryBytes+=bytes.length;
        if(trajectoryBytes>128*1024**2)throw new Error('功能矩阵轨迹副本超过128MiB工具预算');return new Uint8Array(bytes);};
      const readGpuBuffer=(buffer,layout,source,kind)=>{
        const gl=engine._gl,details={frameId,kind,name:source.name,className:source.getClassName?.(),layout},componentBytes=({5120:1,5121:1,5122:2,5123:2,5124:4,5125:4,5126:4,5131:2})[layout?.type];
        const unavailable=(reason,extra={})=>new Error('CLASSIFICATION_CAPTURE_GPU_READ_UNAVAILABLE:'+JSON.stringify({...details,reason,...extra}));
        if(gl.isContextLost())throw unavailable('context-lost');
        if(!componentBytes||!Number.isSafeInteger(layout.size)||layout.size<1||layout.size>4||!Number.isSafeInteger(layout.byteStride)||layout.byteStride<layout.size*componentBytes
          ||!Number.isSafeInteger(layout.byteOffset)||layout.byteOffset<0||layout.byteStride%componentBytes!==0||layout.byteOffset%componentBytes!==0
          ||typeof layout.normalized!=='boolean'||typeof layout.instanced!=='boolean'||!Number.isSafeInteger(layout.divisor)||layout.divisor<0
          ||(layout.instanced?layout.divisor===0:layout.divisor!==0))throw unavailable('unknown-layout');
        const nativeBuffer=buffer.getBuffer?.(),native=nativeBuffer?.underlyingResource;
        if(!native||!gl.isBuffer(native))throw unavailable('native-buffer-unavailable');
        if(buffer.effectiveBuffer&&buffer.effectiveBuffer!==nativeBuffer)throw unavailable('effective-buffer-layout-differs');
        const cached=gpuBuffers.get(native);
        if(cached){if(layout.byteOffset+layout.size*componentBytes>cached.bytes.length)throw unavailable('attribute-outside-buffer');return cached;}
        const previous=gl.getParameter(gl.COPY_READ_BUFFER_BINDING),beforeError=gl.getError();
        if(beforeError!==gl.NO_ERROR)throw unavailable('preexisting-gl-error',{glError:beforeError});
        let bytes,failure,restoreFailure,byteSize;
        try{
          gl.bindBuffer(gl.COPY_READ_BUFFER,native);byteSize=gl.getBufferParameter(gl.COPY_READ_BUFFER,gl.BUFFER_SIZE);
          const sizeError=gl.getError();if(sizeError!==gl.NO_ERROR)throw new Error('BUFFER_SIZE glError='+sizeError);
          if(!Number.isSafeInteger(byteSize)||byteSize<=0||byteSize>128*1024**2)throw new Error('native BUFFER_SIZE outside 1..128MiB: '+byteSize);
          if(layout.byteOffset+layout.size*componentBytes>byteSize)throw new Error('attribute-outside-buffer');
          bytes=new Uint8Array(byteSize);gl.getBufferSubData(gl.COPY_READ_BUFFER,0,bytes);
          if(gl.isContextLost())throw new Error('context-lost-after-read');const readError=gl.getError();if(readError!==gl.NO_ERROR)throw new Error('getBufferSubData glError='+readError);
        }catch(error){failure=error;}
        finally{
          try{gl.bindBuffer(gl.COPY_READ_BUFFER,previous);const restoreError=gl.getError();
            if(restoreError!==gl.NO_ERROR||gl.isContextLost()||gl.getParameter(gl.COPY_READ_BUFFER_BINDING)!==previous)restoreFailure=new Error('COPY_READ binding restoration failed: '+restoreError);
          }catch(error){restoreFailure=error;}
        }
        if(failure||restoreFailure)throw unavailable('read-or-restore-failed',{byteSize,readError:failure?String(failure):null,restoreError:restoreFailure?String(restoreFailure):null});
        const packet={bytes};gpuBuffers.set(native,packet);frozenGeometryBytes+=bytes.length;gpuReadbackBytes+=bytes.length;return packet;
      };
      const freezeGeometry=source=>{
        // carrier只按真实source Mesh归属；跨carrier仅同一wrapper的原始bytes可共享冻结副本。
        if(geometries.has(source))return geometries.get(source);const data=[];
      const vertices = source.getTotalVertices(), indicesCount = source.getTotalIndices();
      const unreadable = () => new Error('CLASSIFICATION_CAPTURE_UNREADABLE_GEOMETRY:' + JSON.stringify({name:source.name,className:source.getClassName?.(),vertices,indicesCount}));
      let kinds;
      if (typeof source.getVerticesDataKinds === 'function') {
        kinds = source.getVerticesDataKinds();
        if (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string') || (vertices > 0 && kinds.length === 0)) throw unreadable();
      } else {
        // 原生AbstractMesh只承载节点/矩阵，没有Mesh的布局API；保留该行全部矩阵，不能将未知有几何对象静默当空。
        if (source.getClassName?.() !== 'AbstractMesh' || vertices !== 0 || indicesCount !== 0 || source.geometry || source.getIndices() !== null) throw unreadable();
        kinds = [];
      }
      for (const kind of [...kinds].sort()) {
        const buffer = source.getVertexBuffer(kind);
        const layout = buffer ? {type:buffer.type,size:buffer.getSize(),byteStride:buffer.byteStride,byteOffset:buffer.byteOffset,
          normalized:buffer.normalized,instanced:buffer.getIsInstanced(),divisor:buffer.instanceDivisor}:null;
        let values = buffer?.getData(), dataSource = 'vertexBuffer.getData',gpuPacket;
        const gl=engine._gl,canReadGpu=engine.webGLVersion>=2&&['getBufferSubData','getBufferParameter','getParameter','bindBuffer','isBuffer','isContextLost','getError'].every(name=>typeof gl[name]==='function')
          &&['COPY_READ_BUFFER','COPY_READ_BUFFER_BINDING','BUFFER_SIZE','NO_ERROR'].every(name=>typeof gl[name]==='number');
        if(!values&&buffer&&canReadGpu){gpuPacket=readGpuBuffer(buffer,layout,source,kind);dataSource='WebGL2.getBufferSubData/native-buffer';}
        if (!values && !gpuPacket && buffer) {
          const match=/^(world|previousWorld)([0-3])$/.exec(kind), storage=source._instanceDataStorage;
          const pass=storage?.useMonoDataStorageRenderPass?storage.dataStorageRenderPass:storage?.renderPasses?.[storage.engine.currentRenderPassId];
          const previous=match?.[1]==='previousWorld', wrapper=previous?pass?.instancesPreviousBuffer:pass?.instancesBuffer;
          const authority=match?(previous?source.previousWorldMatrixInstancedBuffer:source.worldMatrixInstancedBuffer):null;
          // SDK公开实例矩阵数组是当前render-pass上传来源；仅接受同一native wrapper和精确列布局，未知/GPU-only属性继续不可用。
          if(match&&storage?.manualUpdate!==true&&wrapper&&buffer.getWrapperBuffer()===wrapper&&layout.type===5126&&layout.size===4
            &&layout.byteStride===64&&layout.byteOffset===Number(match[2])*16&&layout.instanced===true&&layout.divisor===1
            &&Object.prototype.toString.call(authority)==='[object Float32Array]') {
            values=authority;dataSource=previous?'source.previousWorldMatrixInstancedBuffer/native-wrapper':'source.worldMatrixInstancedBuffer/native-wrapper';
          }
        }
        if (!values && !gpuPacket) throw new Error('CLASSIFICATION_CAPTURE_BUFFER_UNAVAILABLE:'+JSON.stringify({frameId,kind,name:source.name,className:source.getClassName?.(),
          vertices,indicesCount,layout,bufferPresent:Boolean(buffer),cpuMirrorAvailable:Boolean(buffer?.getData()),manualInstanceUpdate:source._instanceDataStorage?.manualUpdate??null}));
        if(typeof buffer.getWrapperBuffer!=='function')throw new Error('CLASSIFICATION_CAPTURE_BUFFER_WRAPPER_UNAVAILABLE:'+kind);
        data.push({kind,packet:gpuPacket??freezeBuffer(buffer.getWrapperBuffer(),values),layout,dataSource});
      }
      const indices = source.getIndices(); if (!indices && indicesCount > 0) throw unreadable();
        if(indices)data.push({kind:'indices',packet:freezeBuffer(indices,indices)});geometries.set(source,data);return data;
      };
      const gl=engine._gl,width=engine.getRenderWidth(),height=engine.getRenderHeight();
      if(width*height*4>128*1024**2)throw new Error('单个功能指纹数组超过128MiB工具预算');
      const pixels=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const meshes=scene.meshes.map(mesh=>{
        const ancestry=[];for(let current=mesh,depth=0;current&&depth<128;current=current.parent,depth++)ancestry.push(current.name);
        const metadata=mesh.metadata??{},worldBytes=freezeMatrix(mesh.getWorldMatrix().m),thin=mesh._thinInstanceDataStorage?.matrixData;
        return {key:[metadata.entityId??metadata.ownerEntityId??'',ancestry.reverse().join('/')].join('|'),worldBytes,thinBytes:thin?freezeMatrix(thin):new Uint8Array(0),
          visible:mesh.isEnabled()&&mesh.isVisible,visibility:mesh.visibility,layerMask:mesh.layerMask,vertices:mesh.getTotalVertices(),indices:mesh.getTotalIndices(),
          thinCount:mesh.thinInstanceCount??0,geometry:freezeGeometry(mesh.sourceMesh??mesh)};
      });
      const camera=scene.activeCamera,frameIdEnd=scene.getFrameId();if(frameIdEnd!==frameId)throw new Error('CLASSIFICATION_CAPTURE_FRAME_CHANGED_DURING_SYNC_SNAPSHOT');
      resolve({pixels,width,height,meshes,frameId,frameIdEnd,frozenGeometryBytes,gpuReadbackBytes,gpuReadbackBuffers:gpuBuffers.size,trajectoryBytes,startedAt,at:performance.now(),camera:{name:camera?.name,alpha:camera?.alpha,beta:camera?.beta,radius:camera?.radius,
        position:camera?.position.asArray(),target:camera?.getTarget?.().asArray(),projection:camera?.mode}});
    }catch(error){reject(error);}
  }));
  // 回调已同步冻结同帧全部原字节；此后的await只hash冻结副本，绝不再读取live mesh/buffer。
  const rows=[],geometryHashes=new Map(),packetHashes=new Map();
  const digest=bytes=>{if(!packetHashes.has(bytes))packetHashes.set(bytes,hash(bytes));return packetHashes.get(bytes);};
  const geometryHash=data=>{
    if(!geometryHashes.has(data))geometryHashes.set(data,Promise.all(data.map(async entry=>{
      const result={kind:entry.kind,bytes:entry.packet.bytes.length,sha256:await digest(entry.packet.bytes)};
      if(entry.layout){result.layout=entry.layout;result.dataSource=entry.dataSource;}return result;
    })));return geometryHashes.get(data);
  };
  for(const item of initial.meshes){
    const data=await geometryHash(item.geometry),{worldBytes,thinBytes}=item;
    rows.push({ key: item.key, visible: item.visible, visibility: item.visibility, layerMask: item.layerMask,
      vertices: item.vertices, indices: item.indices, thinCount: item.thinCount, geometry: data,
      worldSha256:await digest(worldBytes),thinSha256:await digest(thinBytes),worldBytes,thinBytes });
  }
  rows.sort((a, b) => [a.key, a.worldSha256, a.thinSha256, JSON.stringify(a.geometry)].join('|').localeCompare([b.key, b.worldSha256, b.thinSha256, JSON.stringify(b.geometry)].join('|')));
  const trajectoryBytes = rows.reduce((sum, row) => sum + row.worldBytes.length + row.thinBytes.length, 0);
  if (trajectoryBytes > 128 * 1024 ** 2) throw new Error('功能矩阵轨迹副本超过128MiB工具预算');
  const matrixPacket = new Uint8Array(trajectoryBytes); let offset = 0;
  const proof = rows.map(row => {
    const { worldBytes, thinBytes, ...description } = row;
    description.worldOffset = offset; matrixPacket.set(worldBytes, offset); offset += worldBytes.length;
    description.thinOffset = offset; description.thinBytes = thinBytes.length; matrixPacket.set(thinBytes, offset); offset += thinBytes.length;
    return description;
  });
  const colors = new Set();
  for (let index = 0; index < initial.pixels.length && colors.size <= 32; index += 4) colors.add(initial.pixels[index]
    + initial.pixels[index + 1] * 256 + initial.pixels[index + 2] * 65536 + initial.pixels[index + 3] * 16777216);
  return { atMs:initial.at,frameId:initial.frameId,frameIdEnd:initial.frameIdEnd,snapshotStartedAtMs:initial.startedAt,
    frozenGeometryBytes:initial.frozenGeometryBytes,gpuReadbackBuffers:initial.gpuReadbackBuffers,gpuReadbackBytes:initial.gpuReadbackBytes,
    frozenPayloadBytes:initial.frozenGeometryBytes+initial.trajectoryBytes+initial.pixels.length,
    width: initial.width, height: initial.height, camera: initial.camera,
    renderer: engine.getGlInfo(), geometrySha256: await hash(new TextEncoder().encode(JSON.stringify(proof))),
    matrixSha256: await hash(matrixPacket), matrixBytes: matrixPacket.length, matrixBase64: base64(matrixPacket),
    rgbaSha256: await hash(initial.pixels), rgbaBytes: initial.pixels.length, rgbaBase64: base64(initial.pixels), rows: proof,
    nonblankColorsAtLeast: colors.size, actualGeometryMeshes: rows.filter(row => row.vertices > 0).length,
    scope: 'sampled functional points before/after performance only; no proof of unsampled intermediate trajectory' };
}
