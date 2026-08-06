import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcRotateCamera, Camera, NullEngine, Scene, Vector3 } from '@babylonjs/core';

import {
  DIGITAL_TWIN_CAMERA_CONTROL_STANDARD,
  type DigitalTwinCameraPose,
  applyDigitalTwinCameraControlStandard,
  attachDigitalTwinCameraControl,
  applyDigitalTwinCameraSensitivity,
  clampDigitalTwinCameraRadius,
  hasDigitalTwinCameraPoseChanged,
  hasPendingDigitalTwinCameraInput,
  syncDigitalTwinCameraPanScale,
} from '../../src/runtime/babylon/cameraControlStandard.ts';

function createCamera(): { engine: NullEngine; scene: Scene; camera: ArcRotateCamera } {
  const engine = new NullEngine({ renderWidth: 1280, renderHeight: 720 });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('CameraControlStandardTest', Math.PI / 4, Math.PI / 3, 20, Vector3.Zero(), scene);
  return { engine, scene, camera };
}

function disposeCamera(fixture: ReturnType<typeof createCamera>): void {
  fixture.scene.dispose();
  fixture.engine.dispose();
}

function assertClose(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, message ?? `${actual} 应接近 ${expected}`);
}

test('数字孪生保留原有右键旋转、中键平移、Ctrl+左键平移和左键选择习惯', () => {
  const fixture = createCamera();
  try {
    applyDigitalTwinCameraControlStandard(fixture.camera, { zoom: 10, pan: 10, rotate: 10 });

    const pointerEntries = fixture.camera.movement.input.inputMap.filter((entry) => entry.source === 'pointer');
    const wheelEntries = fixture.camera.movement.input.inputMap.filter((entry) => entry.source === 'wheel');

    assert.deepEqual(pointerEntries.map(({ source, button, modifiers, interaction }) => ({
      source,
      button,
      ...(modifiers ? { modifiers } : {}),
      interaction,
    })), [
      { source: 'pointer', button: 0, modifiers: { ctrl: true }, interaction: 'pan' },
      { source: 'pointer', button: 2, interaction: 'rotate' },
      { source: 'pointer', button: 1, interaction: 'pan' },
    ]);
    assert.deepEqual(wheelEntries.map(({ source, interaction }) => ({ source, interaction })), [
      { source: 'wheel', interaction: 'zoom' },
    ]);
    assert.equal(fixture.camera.movement.input.resolveInteraction('pointer', { button: 0, modifiers: { ctrl: false } }), null);
    assert.equal(
      fixture.camera.movement.input.resolveInteraction('pointer', { button: 0, modifiers: { ctrl: true } })?.interaction,
      'pan',
    );
    assert.equal(fixture.camera.movement.input.resolveInteraction('pointer', { button: 1 })?.interaction, 'pan');
    assert.equal(fixture.camera.movement.input.resolveInteraction('pointer', { button: 2 })?.interaction, 'rotate');
  } finally {
    disposeCamera(fixture);
  }
});

test('Babylon 相机控制重新绑定后，中键拖拽仍会产生平移输入', () => {
  const fixture = createCamera();
  try {
    const sensitivity = { zoom: 10, pan: 10, rotate: 10 };
    attachDigitalTwinCameraControl(fixture.camera, sensitivity);
    fixture.camera.detachControl();
    attachDigitalTwinCameraControl(fixture.camera, sensitivity);

    assert.equal(fixture.camera.movement.input.resolveInteraction('pointer', { button: 1 })?.interaction, 'pan');
    assert.equal(fixture.camera.movement.input.resolveInteraction('pointer', { button: 2 })?.interaction, 'rotate');
    assert.equal(fixture.camera.movement.input.getEntries('pointer', 'pan').length, 2);

    const pointerInput = fixture.camera.inputs.attached.pointers as unknown as {
      onButtonDown: (event: { button: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) => void;
      onTouch: (point: null, offsetX: number, offsetY: number) => void;
      onButtonUp: (event: unknown) => void;
    };
    assert.ok(pointerInput, 'ArcRotateCamera 必须启用指针输入');
    pointerInput.onButtonDown({ button: 1, ctrlKey: false, altKey: false, shiftKey: false });
    pointerInput.onTouch(null, 12, 8);
    pointerInput.onButtonUp({});

    assert.deepEqual(fixture.camera.movement.panAccumulatedPixels.asArray(), [-12, 8, 0]);
    assert.deepEqual(fixture.camera.movement.rotationAccumulatedPixels.asArray(), [0, 0, 0]);
  } finally {
    disposeCamera(fixture);
  }
});

test('重复应用数字孪生相机标准不会产生重复或额外鼠标映射', () => {
  const fixture = createCamera();
  try {
    applyDigitalTwinCameraControlStandard(fixture.camera, { zoom: 10, pan: 10, rotate: 10 });
    applyDigitalTwinCameraControlStandard(fixture.camera, { zoom: 10, pan: 10, rotate: 10 });

    assert.equal(fixture.camera.movement.input.getEntries('pointer', 'rotate').length, 1);
    assert.equal(fixture.camera.movement.input.getEntries('pointer', 'pan').length, 2);
    assert.equal(fixture.camera.movement.input.getEntries('wheel', 'zoom').length, 1);
  } finally {
    disposeCamera(fixture);
  }
});

test('旋转角度、屏幕空间平移幅度和滚轮缩放按统一基准及灵敏度倍率计算', () => {
  const fixture = createCamera();
  try {
    applyDigitalTwinCameraControlStandard(fixture.camera, { zoom: 10, pan: 10, rotate: 10 });

    const rotateEntry = fixture.camera.movement.input.getEntry('pointer', 'rotate', { button: 2 });
    const defaultRadiansPerPixel = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.rotation.radiansPerPixelAtDefault;
    const defaultWorldUnitsPerPixel = 2 * fixture.camera.radius * Math.tan(fixture.camera.fov / 2) / 720;

    assertClose(rotateEntry?.sensitivityX ?? Number.NaN, defaultRadiansPerPixel);
    assertClose(rotateEntry?.sensitivityY ?? Number.NaN, defaultRadiansPerPixel);
    assert.equal(fixture.camera.wheelDeltaPercentage, 0.05);
    assertClose(fixture.camera.movement.panSpeed, defaultWorldUnitsPerPixel);

    applyDigitalTwinCameraSensitivity(fixture.camera, { zoom: 20, pan: 5, rotate: 20 });
    syncDigitalTwinCameraPanScale(fixture.camera);

    assertClose(rotateEntry?.sensitivityX ?? Number.NaN, defaultRadiansPerPixel * 2);
    assertClose(rotateEntry?.sensitivityY ?? Number.NaN, defaultRadiansPerPixel * 2);
    assert.equal(fixture.camera.wheelDeltaPercentage, 0.1);
    assertClose(fixture.camera.movement.panSpeed, defaultWorldUnitsPerPixel * 0.5);

    fixture.camera.radius *= 2;
    syncDigitalTwinCameraPanScale(fixture.camera);
    assertClose(fixture.camera.movement.panSpeed, defaultWorldUnitsPerPixel);
    assert.equal(
      fixture.camera.minZ,
      fixture.camera.radius * DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.perspectiveMinZRadiusRatio,
    );
    assert.equal(fixture.camera.lowerRadiusLimit, DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters);
    assert.equal(clampDigitalTwinCameraRadius(0.001), DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters);
  } finally {
    disposeCamera(fixture);
  }
});

test('透视相机缩远时动态提高近裁剪面，正交和近景仍保留 2 cm 下限', () => {
  const fixture = createCamera();
  try {
    applyDigitalTwinCameraControlStandard(fixture.camera, { zoom: 10, pan: 10, rotate: 10 });
    fixture.camera.maxZ = 12_000;

    fixture.camera.radius = 2_400;
    syncDigitalTwinCameraPanScale(fixture.camera);
    assert.equal(fixture.camera.minZ, 2.4, '大尺度透视远景应按半径的 0.1% 提高近裁剪面');

    fixture.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    syncDigitalTwinCameraPanScale(fixture.camera);
    assert.equal(
      fixture.camera.minZ,
      DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minZMeters,
      '正交投影使用线性深度，不应为改善透视深度精度而扩大近裁剪面',
    );

    fixture.camera.mode = Camera.PERSPECTIVE_CAMERA;
    fixture.camera.radius = DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minRadiusMeters;
    syncDigitalTwinCameraPanScale(fixture.camera);
    assert.equal(
      fixture.camera.minZ,
      DIGITAL_TWIN_CAMERA_CONTROL_STANDARD.zoom.minZMeters,
      '近景必须继续保留 2 cm 近裁剪保护，避免贴近模型时被裁空',
    );
  } finally {
    disposeCamera(fixture);
  }
});

test('模型表面上的真实相机输入或位姿变化会被识别为视角拖拽', () => {
  const fixture = createCamera();
  const pose: DigitalTwinCameraPose = {
    alpha: 1,
    beta: 0.8,
    radius: 20,
    target: { x: 0, y: 0, z: 0 },
  };

  try {
    assert.equal(hasDigitalTwinCameraPoseChanged(pose, { ...pose, target: { ...pose.target } }), false);
    assert.equal(hasDigitalTwinCameraPoseChanged(pose, { ...pose, alpha: pose.alpha + 0.001 }), true);
    assert.equal(hasPendingDigitalTwinCameraInput(fixture.camera), false);

    fixture.camera.movement.rotationAccumulatedPixels.x = 0.01;
    assert.equal(hasPendingDigitalTwinCameraInput(fixture.camera), true);
  } finally {
    disposeCamera(fixture);
  }
});
