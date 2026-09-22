import { ArcRotateCamera, Engine, MeshBuilder, Scene, StandardMaterial, Color3, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import { SpatialEffects } from '../../src/runtime/babylon/effects/SpatialEffects';
import { createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect';

const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 500; document.body.append(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
Object.assign(window, { flowArrowDirection: {
  async run(points: { x: number; y: number; z: number }[], advance = 0.5, transformed = false) {
    const scene = new Scene(engine); scene.clearColor.set(0.025, 0.035, 0.05, 1);
    const camera = new ArcRotateCamera('camera', -Math.PI / 2, 0.65, 23, new Vector3(0, 1, 0), scene);
    const ground = MeshBuilder.CreateGround('ground', { width: 24, height: 24 }, scene);
    const material = new StandardMaterial('ground-material', scene); material.disableLighting = true; material.emissiveColor = new Color3(.045, .065, .09); ground.material = material;
    const root = new TransformNode('arrows', scene);
    if (transformed) { root.rotation.set(.3, .7, -.2); root.scaling.set(1.5, .8, 1.2); }
    const component = createDefaultPoiEffectComponent('flow-arrows');
    component.visual!.points = points; component.visual!.duration = 4; component.visual!.width = .7; component.visual!.amount = 2;
    const effect = new SpatialEffects('flow', scene, root, component);
    const arrow = effect.meshes.find(mesh => mesh.metadata?.effectRole === 'moving-arrow')!;
    const render = async () => { for (let i = 0; i < 8; i++) { scene.render(); await new Promise(requestAnimationFrame); } };
    try {
      for (let remaining = advance; remaining > .000001; remaining -= .2) effect.tick(Math.min(.2, remaining));
      await render(); arrow.computeWorldMatrix(true);
      const before = arrow.getAbsolutePosition().clone(); const beforeImage = canvas.toDataURL();
      effect.tick(.15); await render();
      const world = arrow.computeWorldMatrix(true), after = arrow.getAbsolutePosition().clone();
      const positions = arrow.getVerticesData(VertexBuffer.PositionKind)!;
      const tip = Vector3.TransformCoordinates(Vector3.FromArray(positions, 12), world);
      const tail = Vector3.TransformCoordinates(Vector3.FromArray(positions, 0).add(Vector3.FromArray(positions, 6)).scale(.5), world);
      const displacement = after.subtract(before).normalize(), heading = tip.subtract(tail).normalize();
      const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      const project = (p: Vector3) => Vector3.Project(p, ground.getWorldMatrix(), scene.getTransformMatrix(), viewport);
      const headScreen = project(tip).subtract(project(tail)); headScreen.z = 0; headScreen.normalize();
      const moveScreen = project(after).subtract(project(before)); moveScreen.z = 0; moveScreen.normalize();
      return { heading: heading.asArray(), displacement: displacement.asArray(), alignment: Vector3.Dot(heading, displacement),
        screenAlignment: Vector3.Dot(headScreen, moveScreen), beforeImage, afterImage: canvas.toDataURL() };
    } finally { effect.dispose(); scene.dispose(); }
  },
  dispose: () => engine.dispose(),
} });
