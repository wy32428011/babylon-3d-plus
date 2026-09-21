import { AssetContainer, Color3, Engine, FreeCamera, HemisphericLight, MeshBuilder, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { TargetModelEffects } from '../../src/runtime/babylon/effects/TargetModelEffects';
import { SceneEnvironmentRuntime } from '../../src/runtime/babylon/SceneEnvironmentRuntime';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';
import { ENVIRONMENT_EFFECT_TARGET_ID } from '../../src/editor/model/environmentBuildingEffect';

const canvas = document.createElement('canvas');canvas.width=512;canvas.height=512;document.body.append(canvas);
const engine = new Engine(canvas, false, { preserveDrawingBuffer:true, stencil:true });
type Case = { material: 'standard'|'pbr'; environment: boolean; loop: boolean; axis: 'x'|'y'|'z' };
Object.assign(window,{dissolveCompletion:{
  async run(options: Case) {
    const scene=new Scene(engine);scene.clearColor.set(0.015,0.015,0.015,1);
    const camera=new FreeCamera('camera',new Vector3(4,3,-7),scene);camera.setTarget(new Vector3(0,1,0));
    new HemisphericLight('light',new Vector3(0,1,-1),scene);
    let target:TransformNode|null=null;
    const runtime=new TargetModelEffects(scene,()=>target);
    const createMesh=()=>{
      const mesh=MeshBuilder.CreateBox('building',{width:3,height:2,depth:2},scene);mesh.position.y=1;
      const material=options.material==='pbr'?new PBRMaterial('pbr',scene):new StandardMaterial('standard',scene);
      if(material instanceof PBRMaterial){material.albedoColor=new Color3(.62,.31,.12);material.metallic=0;material.roughness=1;}
      else {material.diffuseColor=new Color3(.62,.31,.12);material.specularColor=Color3.Black();}
      mesh.material=material;return mesh;
    };
    let environment:SceneEnvironmentRuntime|null=null;
    if(options.environment){
      environment=new SceneEnvironmentRuntime(scene,{
        loadAssetContainer:async()=>{const container=new AssetContainer(scene);const mesh=createMesh();container.meshes.push(mesh);container.materials.push(mesh.material!);container.rootNodes.push(mesh);container.removeAllFromScene();return container;},
        resolveAssetUrl:url=>url,
        withBuildingEffectMutation:mutate=>runtime.withTargetMutation(ENVIRONMENT_EFFECT_TARGET_ID,mutate),
      });
      await environment.apply({packagePath:'C:/fixture/building.glb',lengthUnit:'meter',unitScaleToMeters:1,placementMode:'scene-base',visible:true,opacity:1,
        transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:1},activeVariantUrl:'editor-asset://local/building.glb',
        variants:[{name:'building',sourcePath:'C:/fixture/building.glb',sourceUrl:'editor-asset://local/building.glb'}]}, {requestId:null,autoAlign:false});
      target=environment.getBuildingEffectTarget();
    }else{target=new TransformNode('target',scene);createMesh().parent=target;}
    const render=async()=>{
      // 只推进渲染，不推进动画时间，确保边界及截图可重复。
      for(let i=0;i<10;i++){scene.render();await new Promise(requestAnimationFrame);}
      return new Uint8Array(await engine.readPixels(0,0,512,512));
    };
    const compare=(base:Uint8Array,current:Uint8Array)=>{
      let changed=0,missing=0,baseCount=0;
      for(let i=0;i<base.length;i+=4){
        const foreground=base[i]>30||base[i+1]>30||base[i+2]>30;
        if(foreground)baseCount++;
        if(foreground&&current[i]<15&&current[i+1]<15&&current[i+2]<15)missing++;
        if(Math.max(Math.abs(base[i]-current[i]),Math.abs(base[i+1]-current[i+1]),Math.abs(base[i+2]-current[i+2]))>3)changed++;
      }
      return{changed,missing,baseCount};
    };
    try{
      const baseline=await render();
      const component=createDefaultPoiEffectComponent('dissolve');component.visual!.targetEntityId=options.environment?ENVIRONMENT_EFFECT_TARGET_ID:'target';
      component.visual!.loop=options.loop;component.visual!.duration=1;component.visual!.progress=1;component.visual!.axis=options.axis;
      runtime.sync('effect',component,true);runtime.tick(.5);
      const midpoint=compare(baseline,await render());
      runtime.tick(.5);
      const completed=compare(baseline,await render());
      const completedImage=canvas.toDataURL();
      runtime.tick(.1);
      const settled=compare(baseline,await render());
      return{...options,midpoint,completed,settled,completedImage};
    }finally{runtime.dispose();environment?.dispose();scene.dispose();}
  },
  dispose:()=>engine.dispose(),
}});
