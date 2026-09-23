import { AbstractMesh, Color3, DynamicTexture, Material, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, Texture, TransformNode, Vector3 } from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';
import { createDefaultDigitalTwinEffectConfig } from '../../../editor/model/digitalTwinEffect';
import { SpatialEffects } from './SpatialEffects';

const KINDS = new Set(['alarm-pulse','warning-beacon','sparks','steam-leak','gas-leak','water-jet','cargo-target-frame','evacuation-route']);
export function supportsConfiguredLegacyEffect(kind: string): boolean { return KINDS.has(kind); }

/** 旧场景仍由原 POI 渲染。此适配器仅负责显式启用专用配置后的可调实现。 */
export class ConfiguredLegacyEffects {
  readonly meshes: Mesh[] = [];
  readonly materials: Material[] = [];
  readonly textures: Texture[] = [];
  private spatial: SpatialEffects | null = null;
  private active = true;
  private disposed = false;
  private phase = 0;
  private label: DynamicTexture | null = null;
  private labelText = '';
  private target: TransformNode | AbstractMesh | null = null;

  constructor(private readonly id: string, private readonly scene: Scene, private readonly root: TransformNode,
    private component: PoiEffectComponent, private readonly resolveTarget?: (id: string)=>TransformNode|AbstractMesh|null) {
    if(component.effectKind==='warning-beacon') this.createBeacon();
    else if(component.effectKind==='cargo-target-frame') this.createFrame();
    else {
      this.spatial=new SpatialEffects(id,scene,root,this.adapt(component),resolveTarget);
      this.syncSpatialResources();
      if(component.effectKind==='evacuation-route') this.createExit();
    }
    this.update(component);
  }

  private parameter(key:string):unknown {return this.component.configuration?.parameters[key];}
  private number(key:string,fallback:number,min=-100000,max=100000):number {
    const value=this.parameter(key);return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
  }
  private vector(key:string,fallback:Vector3):Vector3 {
    const value=this.parameter(key) as {x?:unknown;y?:unknown;z?:unknown}|undefined;
    return value&&[value.x,value.y,value.z].every(v=>typeof v==='number'&&Number.isFinite(v))?new Vector3(value.x as number,value.y as number,value.z as number):fallback;
  }
  private adapt(component:PoiEffectComponent):PoiEffectComponent {
    const kind=component.effectKind, mapped=kind==='alarm-pulse'?'ripple-ring':kind==='evacuation-route'?'flow-arrows':kind==='sparks'||kind==='water-jet'?'snow':'smoke-plume';
    const defaults=createDefaultDigitalTwinEffectConfig(mapped);
    const defaultParameters:Record<string,number|{x:number;y:number;z:number}>=kind==='sparks'?{emissionDirection:{x:0,y:1,z:0},gravity:{x:0,y:-1.4,z:0},particleLifetime:0.55,particleSpeed:3,particleSize:0.08,emitterRadius:0.05,emissionRate:110}
      :kind==='steam-leak'?{emissionDirection:{x:1,y:0.2,z:0},particleLifetime:1.35,particleSpeed:2,particleSize:0.3,emitterRadius:0.08,emissionRate:75}
      :kind==='water-jet'?{emissionDirection:{x:1,y:0,z:0},gravity:{x:0,y:-0.35,z:0},particleLifetime:0.8,particleSpeed:2.8,particleSize:0.08,emitterRadius:0.05,emissionRate:95}
      :kind==='gas-leak'?{emissionDirection:{x:0,y:1,z:0},particleLifetime:2.4,particleSpeed:0.5,particleSize:0.4,emitterRadius:0.45,emissionRate:42}:{};
    const visual={...defaults,...component.visual};
    if(kind==='alarm-pulse') {visual.radius=this.number('radius',1.1,0.01);visual.width=this.number('ringWidth',0.03,0.001);visual.duration=this.number('period',2,0.05);visual.amount=this.number('ringCount',2,1,32);visual.opacity=this.number('opacity',0.7,0,1);}
    if(kind==='evacuation-route') {
      const points=this.parameter('routePoints');
      if(!component.visual?.points&&Array.isArray(points)&&points.length>=2)visual.points=points.slice(0,64).map(p=>({x:Number(p.x),y:Number(p.y),z:Number(p.z)}));
      visual.width=this.number('routeWidth',visual.width,0.005,100);visual.opacity=this.number('opacity',visual.opacity,0,1);
    }
    if(kind==='sparks'||kind==='water-jet') visual.height=0.45;
    return {...component,effectKind:mapped,visual,configuration:component.configuration?{...component.configuration,parameters:{...defaultParameters,...component.configuration.parameters}}:undefined};
  }

  private syncSpatialResources():void {
    if(!this.spatial)return;
    // 保持暴露给 POI 的数组身份，局部拓扑重建后刷新其中的资源引用。
    const extras=this.meshes.filter(mesh=>!mesh.isDisposed()&&mesh.metadata?.legacyExtra);
    const extraMaterials=this.materials.filter(material=>material.metadata?.legacyExtra);
    const extraTextures=this.textures.filter(texture=>texture===this.label);
    this.meshes.splice(0,this.meshes.length,...this.spatial.meshes,...extras);
    this.materials.splice(0,this.materials.length,...this.spatial.materials,...extraMaterials);
    this.textures.splice(0,this.textures.length,...this.spatial.textures,...extraTextures);
  }
  private solid(role:string,color:string,alpha:number):StandardMaterial {
    const material=new StandardMaterial(`${this.id}_${role}_material`,this.scene);material.disableLighting=true;
    material.emissiveColor=Color3.FromHexString(color).scale(this.component.intensity);material.diffuseColor=Color3.Black();material.alpha=alpha;
    material.backFaceCulling=false;material.disableDepthWrite=true;material.metadata={legacyExtra:true,role};this.materials.push(material);return material;
  }
  private own(mesh:Mesh,role:string,material:Material):Mesh {
    mesh.parent=this.root;mesh.isPickable=false;mesh.material=material;mesh.metadata={editorEntityId:this.id,effectRole:role,legacyExtra:true};this.meshes.push(mesh);return mesh;
  }
  private createBeacon():void {
    this.own(MeshBuilder.CreateCylinder(`${this.id}_base`,{diameter:1,height:0.08,tessellation:24},this.scene),'beacon-base',this.solid('base','#30333a',0.95));
    this.own(MeshBuilder.CreateSphere(`${this.id}_dome`,{diameter:1,segments:16},this.scene),'beacon-dome',this.solid('primary',this.component.primaryColor,0.65));
    this.own(MeshBuilder.CreateBox(`${this.id}_sweep`,{width:1,height:0.16,depth:0.05},this.scene),'beacon-sweep',this.solid('secondary',this.component.secondaryColor,0.4));
  }
  private createFrame():void {
    const material=this.solid('primary',this.component.primaryColor,0.18);
    this.own(MeshBuilder.CreateBox(`${this.id}_frame`,{size:1},this.scene),'cargo-frame',material);
    const edgeMaterial=this.solid('secondary',this.component.secondaryColor,0.95);
    for(let i=0;i<24;i++)this.own(MeshBuilder.CreateBox(`${this.id}_corner_${i}`,{size:1},this.scene),'cargo-corner',edgeMaterial);
  }
  private createExit():void {
    this.own(MeshBuilder.CreateSphere(`${this.id}_exit`,{diameter:2,segments:12},this.scene),'route-exit',this.solid('primary',this.component.primaryColor,0.85));
    if(typeof document==='undefined'&&typeof OffscreenCanvas==='undefined')return;
    this.label=new DynamicTexture(`${this.id}_exit_label`,{width:512,height:128},this.scene,false);this.label.hasAlpha=true;this.textures.push(this.label);
    const material=this.solid('label','#ffffff',1);material.diffuseTexture=this.label;material.emissiveTexture=this.label;material.useAlphaFromDiffuseTexture=true;
    this.own(MeshBuilder.CreatePlane(`${this.id}_exit_label`,{width:2,height:0.5},this.scene),'exit-label',material).billboardMode=Mesh.BILLBOARDMODE_ALL;
  }

  update(component:PoiEffectComponent):void {
    if(this.disposed)return;this.component=component;
    if(this.spatial){this.spatial.update(this.adapt(component));this.syncSpatialResources();}
    for(const material of this.materials) if(material instanceof StandardMaterial&&material.metadata?.legacyExtra){
      const role=material.metadata.role;
      if(role==='primary'||role==='secondary')material.emissiveColor=Color3.FromHexString(role==='primary'?component.primaryColor:component.secondaryColor).scale(component.intensity);
      if(this.parameter('opacity')!==undefined&&role!=='base'&&role!=='label'&&(component.effectKind!=='cargo-target-frame'||role==='primary'))material.alpha=this.number('opacity',0.65,0,1);
    }
    if(component.effectKind==='warning-beacon')this.updateBeacon();
    if(component.effectKind==='cargo-target-frame'){this.target=null;this.updateFrame();}
    if(component.effectKind==='evacuation-route')this.updateExit();
  }
  private updateBeacon():void {
    const base=this.meshes[0],dome=this.meshes[1],beam=this.meshes[2];
    base.scaling.set(this.number('baseRadius',0.175,0.01)*2,1,this.number('baseRadius',0.175,0.01)*2);base.visibility=this.parameter('showBase')===false?0:1;
    dome.scaling.setAll(this.number('domeRadius',0.225,0.01)*2);dome.position.y=this.number('beaconHeight',0.25,0);
    beam.scaling.x=this.number('beamLength',1.35,0.01);beam.position.y=dome.position.y+0.05;
  }
  private updateExit():void {
    const points=this.adapt(this.component).visual!.points;
    const end=this.parameter('flowDirection')==='reverse'?points[0]:points.at(-1);if(!end)return;
    const radius=this.number('exitSize',0.22,0.01),visible=this.parameter('showExit')!==false;
    for(const mesh of this.meshes)if(mesh.metadata?.effectRole==='route-exit'||mesh.metadata?.effectRole==='exit-label'){
      mesh.visibility=visible?1:0;mesh.position.set(end.x,end.y+radius+this.number('elevation',0),end.z);
      if(mesh.metadata.effectRole==='route-exit')mesh.scaling.setAll(radius);else mesh.position.y+=radius+0.35;
    }
    const labelText=String(this.parameter('exitLabel')??'安全出口').slice(0,40);
    if(this.label&&labelText!==this.labelText){this.labelText=labelText;const context=this.label.getContext() as CanvasRenderingContext2D;context.clearRect(0,0,512,128);context.fillStyle='#ffffff';context.font='bold 48px sans-serif';context.textAlign='center';context.fillText(labelText,256,82,500);this.label.update();}
  }
  private updateFrame():void {
    const targetId=this.component.visual?.targetEntityId??this.component.configuration?.target?.entityId;
    if(targetId&&(!this.target||this.target.isDisposed()))this.target=this.resolveTarget?.(targetId)??null;
    let size=this.vector('frameSize',new Vector3(1.25,1,1.25)),center=new Vector3(0,size.y*0.5,0);
    if(this.parameter('autoBounds')!==false&&this.target&&!this.target.isDisposed()){
      this.root.computeWorldMatrix(true);const inverse=Matrix.Invert(this.root.getWorldMatrix());
      const meshes=[...(this.target instanceof AbstractMesh?[this.target]:[]),...this.target.getChildMeshes(false)];
      let minimum=new Vector3(Infinity,Infinity,Infinity),maximum=new Vector3(-Infinity,-Infinity,-Infinity);
      for(const mesh of meshes){if(mesh.getTotalVertices()===0||mesh===this.meshes[0]||mesh.metadata?.editorEntityId===this.id)continue;mesh.computeWorldMatrix(true);for(const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld){const local=Vector3.TransformCoordinates(corner,inverse);minimum=Vector3.Minimize(minimum,local);maximum=Vector3.Maximize(maximum,local);}}
      if(Number.isFinite(minimum.x)){size=maximum.subtract(minimum);center=minimum.add(maximum).scale(0.5);}
    }
    size=size.add(new Vector3(1,1,1).scale(this.number('padding',0.1,0)*2));size.set(Math.max(0.001,size.x),Math.max(0.001,size.y),Math.max(0.001,size.z));
    const frame=this.meshes[0];frame.scaling.copyFrom(size);frame.position.copyFrom(center);
    const ratio=this.number('cornerRatio',0.25,0.01,0.5),thickness=Math.max(0.005,this.number('edgeWidth',3,0.1,20)*0.005);let index=1;
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])for(let axis=0;axis<3;axis++){
      const corner=this.meshes[index++],signs=[x,y,z],dimensions=[size.x,size.y,size.z];const position=center.add(new Vector3(x*size.x,y*size.y,z*size.z).scale(0.5));
      const length=dimensions[axis]*ratio;const values=position.asArray();values[axis]-=signs[axis]*length*0.5;corner.position.copyFromFloats(values[0],values[1],values[2]);corner.scaling.set(thickness,thickness,thickness);if(axis===0)corner.scaling.x=length;else if(axis===1)corner.scaling.y=length;else corner.scaling.z=length;
    }
  }
  tick(deltaSeconds:number):void {
    if(!this.active||this.disposed||!Number.isFinite(deltaSeconds)||deltaSeconds<=0)return;
    this.spatial?.tick(deltaSeconds);
    if(this.component.effectKind==='warning-beacon') {this.phase=(this.phase+Math.min(deltaSeconds,0.25)*this.component.speed*this.number('revolutionsPerMinute',30,-600,600)*Math.PI/30)%(Math.PI*2);this.meshes[2].rotation.y=this.phase;}
    if(this.component.effectKind==='cargo-target-frame'&&this.parameter('followTarget')!==false)this.updateFrame();
  }
  setActive(active:boolean):void {this.active=active;this.spatial?.setActive(active);for(const mesh of this.meshes)mesh.setEnabled(active);}
  updatePlaybackSpeed(speed:number):void {this.component={...this.component,speed};this.spatial?.updatePlaybackSpeed(speed);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.spatial?.dispose();
    for(const mesh of this.meshes)if(!mesh.isDisposed())mesh.dispose(false,false);
    for(const material of this.materials)material.dispose(false,false);
    for(const texture of this.textures)texture.dispose();this.meshes.length=0;this.materials.length=0;this.textures.length=0;this.target=null;this.label=null;
  }
}
