/** 注册项目 WebGL 2 渲染、拾取、碰撞、动画、薄实例、描边与后处理所需的 Babylon.js 原型扩展与场景组件。 */
import '@babylonjs/core/Animations/animatable.js';
// 手动漫游的 moveWithCollisions 依赖此入口注册默认碰撞协调器。
import '@babylonjs/core/Collisions/collisionCoordinator.js';
import '@babylonjs/core/Culling/ray.js';
// 模块化Engine入口不会自动注册ThinEngine计时扩展；否则仪表会调用抽象空实现并永久显示N/A。
import '@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery.js';
import '@babylonjs/core/Engines/Extensions/engine.query.js';
import '@babylonjs/core/Layers/effectLayerSceneComponent.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import '@babylonjs/core/Materials/standardMaterial.js';
import '@babylonjs/core/Materials/Textures/baseTexture.polynomial.js';
import '@babylonjs/core/Meshes/instancedMesh.js';
import '@babylonjs/core/Meshes/linesMesh.js';
import '@babylonjs/core/Meshes/subMesh.project.js';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent.js';
import '@babylonjs/core/Rendering/boundingBoxRenderer.js';
import '@babylonjs/core/Rendering/depthRendererSceneComponent.js';
import '@babylonjs/core/Rendering/edgesRenderer.js';
import '@babylonjs/core/Rendering/outlineRenderer.js';
