import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { compileSkyboxEnvironment } from '../../src/editor/assets/skyboxEnvironmentCompiler.ts';
import { SceneSkyboxRuntime } from '../../src/runtime/babylon/SceneSkyboxRuntime.ts';
import * as contract from '../../electron/shared/sceneSkyboxContract.ts';
import { captureLightingEnvironment } from '../../src/runtime/babylon/lightingRuntimeCapture.ts';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';

// 全部与产品使用同一套 Vite 模块身份，不能混入 /node_modules 原始 URL 的第二套 Babylon 类。
Object.assign(window, { __skyboxModules: { Engine, Scene, ArcRotateCamera, Camera, Vector3, CreateSphere, CreateBox, Texture, PBRMaterial,
  compileSkyboxEnvironment, SceneSkyboxRuntime, captureLightingEnvironment, createEmptySceneDocument, getSceneLightingBakeSignature }, __skyboxContract: contract, __skyboxModulesReady: true });
