import { AbstractMesh, TransformNode, Vector3, Matrix, Quaternion, type Scene } from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { PoiEffectComponent } from '../../editor/model/components';
import type { EffectConfiguration, EffectDiagnostic, EffectRuntimeTarget, EffectDeviceIdentity } from '../../editor/model/effectConfiguration';
import { effectDeviceIdentity, resolveEffectTargets, type EffectTargetResolution } from '../../editor/model/effectTargets';
import { getEffectParameterDefinitions } from '../../editor/model/effectParameterRegistry';
import { MODEL_EFFECT_KINDS } from '../../editor/model/digitalTwinEffect';
import { applyEffectDataMappings, createEffectTriggerState, evaluateEffectTrigger, type EffectTriggerState } from '../../editor/model/effectDataMapping';
import { EffectDataRuntime } from './EffectDataRuntime';
import { clearEffectDiagnostic, publishEffectDiagnostic, registerEffectFollowSelection } from './effectDiagnostics';
import { resolveRuntimeEffectTargets, runtimeTargetLockKey, type RuntimeEffectResolution } from './runtimeEffectTargets';

type Slot = { trigger: EffectTriggerState; previous: PoiEffectComponent | null; identity: string; paused: boolean; dataKey: string; resultKey: string };
type Input = { entity: Entity; selected: boolean; visible: boolean; pickable: boolean; resolutionKey: string; resolution: EffectTargetResolution | RuntimeEffectResolution | null; slots: Map<string, Slot>;
  targetSignature?: string; selectedId?: string | null; lockedKey?: string | null; lockedId?: string | null; waitingDataKey?: string };
type Anchor = { node: TransformNode; sourceId: string; config: EffectConfiguration; paused: boolean; visible: boolean; entryId: string; attach: boolean; basePosition: Vector3; issue?: string;
  partRoot?: TransformNode | AbstractMesh; partSelector?: string; partNode?: TransformNode | null; partCheckAt?: number; partIssue?: string };
type Host = {
  resolveNode: (id: string) => TransformNode | AbstractMesh | null;
  isRunning: () => boolean;
  apply: (entity: Entity, selected: boolean, visible: boolean, pickable: boolean) => void;
  remove: (id: string) => void;
  getRoot: (id: string) => TransformNode | null;
  cameraStatus?: (id: string) => string;
  modelStatus?: (id: string) => { status: string; message: string };
  getRuntimeTargets?: () => readonly EffectRuntimeTarget[];
};

/** 编辑配置与实时数据分离：仅运行时投影参数，绝不写入 Store/撤销历史。 */
export class EffectBindingRuntime {
  private document: SceneDocument | null = null;
  private revision = 0;
  private elapsed = 0;
  private time = 0;
  private readonly inputs = new Map<string, Input>();
  private readonly anchors = new Map<string, Anchor>();
  private readonly data = new EffectDataRuntime();
  private runtimeTargets: readonly EffectRuntimeTarget[] = [];
  private runtimeSignature = '';
  private wasRunning = false;
  private runtimeRefreshAt = -Infinity;
  constructor(private readonly scene: Scene, private readonly host: Host) {}

  setDocument(document: SceneDocument): void {
    if (this.document?.entities !== document.entities || this.document?.entityIds !== document.entityIds || this.document?.sceneSettings.environment !== document.sceneSettings.environment) this.revision++;
    this.document = document;
  }
  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    const existing = this.inputs.get(entity.id);
    const input: Input = existing ?? { entity, selected, visible, pickable, resolutionKey: '', resolution: null, slots: new Map() };
    Object.assign(input, { entity, selected, visible, pickable }); this.inputs.set(entity.id, input);
    this.refreshRuntimeTargets(); this.evaluate(input); this.updateAnchors();
    this.retainData();
  }
  detach(id: string): void {
    const input=this.inputs.get(id);if(!input)return;
    for(const slot of input.slots.keys())this.removeSlot(slot);
    this.inputs.delete(id);clearEffectDiagnostic(id);this.retainData();
  }
  private retainData(): void { this.data.releaseUnused([...this.inputs.values()].flatMap(input=>[input.waitingDataKey ?? '', ...[...input.slots.values()].map(slot=>slot.dataKey)].filter(Boolean))); }
  private refreshRuntimeTargets(): void {
    const running = this.host.isRunning();
    if (running === this.wasRunning && this.time - this.runtimeRefreshAt < .25) return;
    this.runtimeRefreshAt = this.time;
    if (running !== this.wasRunning) {
      for (const input of this.inputs.values()) { input.selectedId = null; input.lockedKey = null; input.lockedId = null; input.resolutionKey = ''; }
      this.wasRunning = running;
    }
    const targets = running ? this.host.getRuntimeTargets?.() ?? [] : [];
    const signature = JSON.stringify(targets);
    if (signature !== this.runtimeSignature) { this.runtimeSignature = signature; this.runtimeTargets = targets; this.revision++; }
  }
  resolveAnchor(id: string): TransformNode | null { return this.anchors.get(id)?.node ?? null; }
  tick(delta: number): void {
    this.time += delta;
    this.elapsed += delta;
    if (this.elapsed >= .25) {
      this.elapsed = 0;
      this.refreshRuntimeTargets();
      for (const input of this.inputs.values()) this.evaluate(input);
      this.data.releaseUnused();
    }
    this.updateAnchors();
  }
  private evaluate(input: Input): void {
    const authored = input.entity.components.poiEffect!, configuration = authored.configuration;
    if (!configuration) return;
    if (!this.document) { this.host.apply(input.entity,input.selected,input.visible,input.pickable);return; }
    const bindingSignature = JSON.stringify(configuration.target);
    if (input.targetSignature !== bindingSignature) {
      input.targetSignature = bindingSignature; input.selectedId = null; input.lockedKey = null; input.lockedId = null; input.resolutionKey = '';
    }
    const runtimeFollow = authored.effectKind === 'target-follow' && ['model','device'].includes(configuration.target.mode);
    registerEffectFollowSelection(input.entity.id, runtimeFollow ? targetId => {
      if (!this.host.isRunning()) return;
      if (targetId && !input.resolution?.candidates.some(candidate => candidate.id === targetId && (!('state' in candidate) || candidate.state === 'ready'))) return;
      input.selectedId = targetId; input.lockedKey = null; input.lockedId = null; input.resolutionKey = '';
      this.evaluate(input); this.updateAnchors(); this.retainData();
    } : null);
    const key = this.revision + ':' + bindingSignature;
    if (input.resolutionKey !== key) {
      input.resolution = runtimeFollow
        ? resolveRuntimeEffectTargets(this.document, configuration.target, this.runtimeTargets, {selectedId: input.selectedId, lockedKey: input.lockedKey})
        : resolveEffectTargets(this.document, configuration.target, authored.effectKind);
      input.resolutionKey = key;
      if ('targets' in input.resolution && input.resolution.targets.length === 1) {
        input.lockedKey = runtimeTargetLockKey(input.resolution.targets[0]); input.lockedId = input.resolution.targets[0].id;
        input.selectedId = null;
      }
    }
    const resolution = input.resolution!;
    const candidates = resolution.candidates;
    let diagnostic: EffectDiagnostic = { status: resolution.status === 'resolved' ? 'static' : resolution.status === 'limit' ? 'invalid' : resolution.status,
      message: resolution.message, candidates, identity: null, updatedAt: null, fields: {} };
    const ids = resolution.status === 'resolved' ? (resolution.ids.length ? resolution.ids : ['']) : [];
    const wanted = new Set<string>();
    input.waitingDataKey = '';
    let selectedDescriptor: EffectRuntimeTarget | undefined;
    for (let index = 0; index < ids.length; index++) {
      const targetId = ids[index], id = index === 0 ? input.entity.id : `${input.entity.id}::effect-target::${targetId}`;
      wanted.add(id);
      const descriptor = 'targets' in resolution ? resolution.targets.find(target => target.id === targetId) : undefined;
      selectedDescriptor = descriptor;
      const identity = configuration.data.inheritFrom === 'carrier' ? descriptor?.carrierIdentity ?? null
        : descriptor?.identity ?? (descriptor ? null : effectDeviceIdentity(this.document.entities[targetId]));
      const identityKey = JSON.stringify([targetId,descriptor?.generation,identity,configuration.data.mode,configuration.data.inheritFrom,configuration.data.sourceId,configuration.data.deviceType,configuration.data.assetCode,configuration.data.http]);
      let slot = input.slots.get(id);
      if (!slot || slot.identity !== identityKey) { slot = { trigger: createEffectTriggerState(), previous: null, identity: identityKey, paused: false, dataKey: '', resultKey: '' }; input.slots.set(id, slot); }
      const requesting=this.host.isRunning() && input.visible && authored.enabled;
      const result = this.data.read(configuration.data, identity, requesting);
      if(result.key && slot.resultKey && result.key!==slot.resultKey){slot.previous=null;slot.trigger=createEffectTriggerState();}
      if(result.key)slot.resultKey=result.key;
      slot.dataKey=requesting?result.key:'';
      const mapped = applyEffectDataMappings(authored, result, { parameterDefinitions: getEffectParameterDefinitions(authored.effectKind) });
      const missing = (result.status !== 'online' && result.status !== 'static') || mapped.issues.length > 0;
      let projected = mapped.component;
      if(configuration.data.dataset.enabled && configuration.data.dataset.coordinateSpace==='world' && projected.visual && result.status==='online') {
        const transform=input.entity.components.transform;
        const inverse=Matrix.Compose(Vector3.FromArray([transform.scale.x,transform.scale.y,transform.scale.z]),Quaternion.FromEulerAngles(transform.rotation.x,transform.rotation.y,transform.rotation.z),Vector3.FromArray([transform.position.x,transform.position.y,transform.position.z])).invert();
        projected.visual={...projected.visual,points:projected.visual.points.map(p=>{const v=Vector3.TransformCoordinates(new Vector3(p.x,p.y,p.z),inverse);return{x:v.x,y:v.y,z:v.z};})};
      }
      if(result.status==='online' && !mapped.issues.length && ['dissolve','path-reveal','floor-expand','explode','clip-section'].includes(projected.effectKind)
        && configuration.data.mappings.some(mapping=>['visual.progress','configuration.parameters.progress'].includes(mapping.target)) && projected.configuration) {
        const progress=configuration.data.mappings.some(mapping=>mapping.target==='configuration.parameters.progress')?projected.configuration.parameters.progress:projected.visual?.progress;
        projected.configuration={...projected.configuration,parameters:{...projected.configuration.parameters,progressMode:projected.effectKind==='path-reveal'?'data':'external',...(typeof progress==='number'?{progress}:{})}};
      }
      if (missing && configuration.data.missing !== 'hide' && slot.previous) projected = slot.previous;
      if (!missing) slot.previous = projected;
      const trigger = evaluateEffectTrigger(configuration.data, result, slot.trigger); slot.trigger = trigger.state;
      const runningData = configuration.data.mode !== 'none' && this.host.isRunning();
      slot.paused = runningData && missing && configuration.data.missing === 'pause';
      const active = authored.enabled && projected.enabled && (!runningData || trigger.active) && !(runningData && missing && (configuration.data.missing === 'hide' || !slot.previous));
      projected = { ...projected, enabled: active, speed: slot.paused ? 0 : projected.speed,
        visual: projected.visual ? { ...projected.visual, targetEntityId: targetId || null } : undefined };
      const material = MODEL_EFFECT_KINDS.has(authored.effectKind);
      if (material && configuration.target.anchor === 'node' && configuration.target.nodePath && projected.configuration) projected.configuration = { ...projected.configuration, parameters: { ...projected.configuration.parameters, nodePaths: configuration.target.nodePath } };
      if (targetId && !material && authored.effectKind !== 'cargo-target-frame') {
        const anchorId = `${id}::effect-anchor::${targetId}`;
        for(const [key, previous] of this.anchors)if(previous.entryId===id&&key!==anchorId){previous.node.dispose();this.anchors.delete(key);}
        let anchor = this.anchors.get(anchorId);
        if (!anchor) { anchor = { node: new TransformNode(anchorId, this.scene), sourceId: targetId, config: configuration, paused: false, visible: false, entryId: id, attach: false, basePosition: Vector3.Zero() }; this.anchors.set(anchorId, anchor); }
        anchor.sourceId = targetId; anchor.config = configuration; anchor.paused = slot.paused; anchor.visible=input.visible&&active;
        anchor.attach = !['target-follow','motion-trail','cargo-target-frame'].includes(authored.effectKind) && !(configuration.data.dataset.enabled && configuration.data.dataset.coordinateSpace === 'world');
        anchor.basePosition.copyFromFloats(input.entity.components.transform.position.x,input.entity.components.transform.position.y,input.entity.components.transform.position.z);
        projected.visual = projected.visual ? { ...projected.visual, targetEntityId: anchorId } : projected.visual;
      } else {
        for(const [key, previous] of this.anchors)if(previous.entryId===id){previous.node.dispose();this.anchors.delete(key);}
      }
      if(authored.effectKind==='cargo-target-frame'&&targetId){const node=this.host.resolveNode(targetId);if(!node||!node.isEnabled())projected={...projected,enabled:false};}
      this.host.apply({ ...input.entity, id, components: { ...input.entity.components, poiEffect: projected } }, input.selected && index === 0, input.visible, input.pickable && index === 0);
      const node = targetId ? this.host.resolveNode(targetId) : null;
      diagnostic = { status: targetId && !node ? 'loading' : mapped.issues.length || trigger.issue ? 'invalid' : result.status === 'missing' ? 'waiting' : result.status,
        message: targetId && !node ? '目标已匹配，等待模型加载' : [...mapped.issues, ...(trigger.issue ? [trigger.issue] : []), result.message].filter(Boolean).join('；'),
        candidates, identity, updatedAt: result.receivedAt, fields: result.fields };
      const modelStatus=material?this.host.modelStatus?.(id):null;
      if(modelStatus&&['loading','occupied','invalid'].includes(modelStatus.status)&&!missing)diagnostic={...diagnostic,status:modelStatus.status==='occupied'?'paused':modelStatus.status as 'loading'|'invalid',message:modelStatus.message};
      if(runningData&&!missing&&!active)diagnostic={...diagnostic,status:'paused',message:trigger.active?'数据映射已关闭此特效':'触发条件未满足'};
    }
    for (const id of input.slots.keys()) if (!wanted.has(id)) { this.removeSlot(id); input.slots.delete(id); }
    if (!wanted.size) {
      const target = configuration.target;
      const explicitIdentity: EffectDeviceIdentity | null = configuration.data.inheritFrom !== 'carrier'
        && (target.instanceKey ?? 'assetCode') === 'assetCode' && target.sourceId && target.deviceType && target.assetCode
        ? {sourceId:target.sourceId,deviceType:target.deviceType,assetCode:target.assetCode} : null;
      const requesting = this.host.isRunning() && input.visible && authored.enabled;
      const data = this.data.read(configuration.data, explicitIdentity, requesting);
      input.waitingDataKey = requesting ? data.key : '';
      diagnostic = {...diagnostic, identity:explicitIdentity, fields:data.fields, updatedAt:data.receivedAt,
        message:diagnostic.message + (data.status === 'online' ? '；数据已就绪' : configuration.data.mode !== 'none' ? '；'+data.message : '')};
      // 保留配置实体的编辑标记，未匹配时不会将相机带到原点或创建替代设备。
      const waitingFollow=authored.effectKind==='target-follow';
      this.host.apply({ ...input.entity, components: { ...input.entity.components, poiEffect: { ...authored, enabled: waitingFollow ? authored.enabled : false,
        visual: authored.visual ? {...authored.visual,targetEntityId:waitingFollow?`${input.entity.id}::waiting-target`:null}:undefined } } },input.selected,input.visible,input.pickable);
    }
    const cameraStatus = authored.effectKind === 'target-follow' ? this.host.cameraStatus?.(input.entity.id) : null;
    if (cameraStatus === 'active' && ids.length && ['static','online'].includes(diagnostic.status)) {
      diagnostic = {...diagnostic, message:`正在跟随 ${selectedDescriptor?.name ?? this.document.entities[ids[0]]?.name ?? '目标'}；${diagnostic.message}`};
    }
    if (cameraStatus === 'paused' || cameraStatus === 'occupied') diagnostic = { ...diagnostic, status: 'paused', message: cameraStatus === 'paused' ? '镜头已由用户接管，可点击恢复跟随' : '另一个镜头组件正在控制相机' };
    const anchorIssue=[...this.anchors.values()].find(anchor=>input.slots.has(anchor.entryId)&&anchor.issue)?.issue;
    if(anchorIssue)diagnostic={...diagnostic,status:'invalid',message:anchorIssue};
    publishEffectDiagnostic(input.entity.id, { ...diagnostic,
      effectKind: this.host.isRunning() && input.visible && authored.enabled ? authored.effectKind : undefined,
      effectName:input.entity.name, selectedTargetId:ids[0] || input.lockedId || null, bindingSignature,
      targetIdentity:selectedDescriptor?.identity ?? effectDeviceIdentity(this.document.entities[ids[0]]),
      carrierIdentity:selectedDescriptor?.carrierIdentity ?? null,
    });
  }
  private updateAnchors(): void {
    for (const anchor of this.anchors.values()) {
      const visualRoot=anchor.attach?this.host.getRoot(anchor.entryId):null;
      if(!anchor.visible){anchor.node.setEnabled(false);visualRoot?.setEnabled(false);continue;}
      let source = this.host.resolveNode(anchor.sourceId);
      anchor.issue=undefined;
      if (source && anchor.config.target.anchor === 'node' && anchor.config.target.nodePath) {
        const root=source, selector=anchor.config.target.nodePath.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
        if(anchor.partRoot!==root||anchor.partSelector!==selector||anchor.partNode?.isDisposed()||!anchor.partNode&&this.time>=(anchor.partCheckAt??0)){
        const nodes=source.getDescendants(false).filter((node):node is TransformNode=>node instanceof TransformNode);
        const matches=nodes.filter(node=>{
          if(node.id===selector||node.name===selector)return true;
          const parts:string[]=[];let current:typeof node.parent=node;
          while(current&&current!==root){parts.unshift(current.name);current=current.parent;}
          return parts.join('/')===selector||parts.join('/').endsWith('/'+selector);
        });
        anchor.partRoot=root;anchor.partSelector=selector;anchor.partNode=matches.length===1?matches[0]:null;anchor.partCheckAt=this.time+.25;
        anchor.partIssue=anchor.partNode?undefined:matches.length?'部件名称不唯一，请填写完整部件路径':'未找到指定部件，请检查部件路径';
        }
        source=anchor.partNode??null;anchor.issue=anchor.partIssue;
      }
      if (!source || source.isDisposed() || !source.isEnabled()) { anchor.node.setEnabled(false); visualRoot?.setEnabled(false);continue; }
      if (anchor.paused) continue;
      source.computeWorldMatrix(true); let position = source.getAbsolutePosition().clone();
      if (anchor.config.target.anchor === 'center') {
        const meshes = source instanceof AbstractMesh ? [source,...source.getChildMeshes()] : source.getChildMeshes();
        let minimum: Vector3|null=null, maximum: Vector3|null=null;
        for (const mesh of meshes) { if (!mesh.getTotalVertices()) continue; mesh.computeWorldMatrix(true); const b=mesh.getBoundingInfo().boundingBox; minimum=minimum?Vector3.Minimize(minimum,b.minimumWorld):b.minimumWorld.clone();maximum=maximum?Vector3.Maximize(maximum,b.maximumWorld):b.maximumWorld.clone(); }
        if(minimum&&maximum)position=minimum.add(maximum).scale(.5);
        else if(source.metadata?.effectBounds)position=source.metadata.effectBounds.minimum.add(source.metadata.effectBounds.maximum).scale(.5);
      }
      const offset = anchor.config.target.offset;
      position.addInPlace(Vector3.TransformNormal(new Vector3(offset.x,offset.y,offset.z),source.getWorldMatrix()));
      anchor.node.rotationQuaternion ??= Quaternion.Identity();
      source.getWorldMatrix().decompose(anchor.node.scaling,anchor.node.rotationQuaternion);
      anchor.node.position.copyFrom(position); anchor.node.setEnabled(true);
      if (visualRoot){visualRoot.position.copyFrom(position.add(anchor.basePosition));visualRoot.setEnabled(true);}
    }
  }
  private removeSlot(id: string): void {
    this.host.remove(id);for(const [key, anchor] of this.anchors)if(anchor.entryId===id){anchor.node.dispose();this.anchors.delete(key);}
  }
  disposeMissing(ids: Set<string>): Set<string> {
    for(const id of this.inputs.keys())if(!ids.has(id))this.detach(id);
    return new Set([...ids,...[...this.inputs.values()].flatMap(input=>[...input.slots.keys()])]);
  }
  dispose(): void { this.disposeMissing(new Set()); this.data.dispose(); for(const anchor of this.anchors.values())anchor.node.dispose();this.anchors.clear(); }
}
