import { useEffect, useRef, useState } from 'react';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ManualRoamRuntime, createInitialManualRoamSnapshot, type ManualRoamSnapshot } from '../../runtime/roam/ManualRoamRuntime';
import '../../styles/manual-roam-avatar-preview.css';

type Props = { name: string; sourceUrl?: string; onClose: () => void; onApply?: () => void };

/** 在独立场景使用正式漫游控制器预览，避免另做一套与发布效果不同的动画播放器。 */
export function ManualRoamAvatarPreviewDialog({ name, sourceUrl, onClose, onApply }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ManualRoamRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<ManualRoamSnapshot>(createInitialManualRoamSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('站立');

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: Engine | undefined, scene: Scene | undefined;
    let runtime: ManualRoamRuntime | undefined, unsubscribe: (() => void) | undefined;
    let resize: ResizeObserver | undefined;
    let disposed = false;
    try {
      engine = new Engine(canvas, true, { stencil: true });
      engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
      scene = new Scene(engine);
      scene.clearColor.set(.10, .12, .15, 1);
      const camera = new ArcRotateCamera('avatar-preview-camera', -Math.PI / 2, 1.2, 3.5, new Vector3(0, .85, 0), scene);
      camera.attachControl(canvas, true);
      const light = new HemisphericLight('avatar-preview-light', new Vector3(.4, 1, -.3), scene);
      light.intensity = 1.3;
      const ground = MeshBuilder.CreateGround('avatar-preview-ground', { width: 200, height: 200 }, scene);
      ground.checkCollisions = true;
      const material = new StandardMaterial('avatar-preview-floor', scene);
      material.diffuseColor = new Color3(.23, .27, .31);
      material.specularColor = Color3.Black();
      ground.material = material;
      const gridLines: Vector3[][] = [];
      for (let coordinate = -30; coordinate <= 30; coordinate++) {
        gridLines.push([new Vector3(-30, .002, coordinate), new Vector3(30, .002, coordinate)]);
        gridLines.push([new Vector3(coordinate, .002, -30), new Vector3(coordinate, .002, 30)]);
      }
      const grid = MeshBuilder.CreateLineSystem('avatar-preview-grid', { lines: gridLines }, scene);
      grid.color = new Color3(.35, .39, .43);
      grid.isPickable = false;
      runtime = new ManualRoamRuntime({ scene, engine, camera, canvas, avatarUrl: sourceUrl,
        resolveSpawnPose: () => ({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }),
        setOrbitControlsEnabled: enabled => enabled ? camera.attachControl(canvas, true) : camera.detachControl(),
      });
      runtimeRef.current = runtime;
      // 预览以全身为构图中心，保留正式漫游的动作、重力和碰撞参数。
      runtime.updateConfig({ thirdPersonHeight: .85, thirdPersonDistance: 3.4 });
      const current = runtime;
      unsubscribe = runtime.subscribe(() => { if (!disposed) setSnapshot(current.getSnapshot()); });
      runtime.setEnabled(true);
      setSnapshot(runtime.getSnapshot());
      resize = new ResizeObserver(() => engine?.resize());
      resize.observe(canvas);
      engine.runRenderLoop(() => {
        if (disposed) return;
        try { scene?.render(); }
        catch (reason) {
          engine?.stopRenderLoop();
          setError(`预览失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      });
    } catch (reason) {
      setError(`无法创建人物预览：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    return () => {
      disposed = true;
      runtimeRef.current = null;
      resize?.disconnect();
      unsubscribe?.();
      engine?.stopRenderLoop();
      runtime?.dispose();
      scene?.dispose();
      engine?.dispose();
    };
  }, [sourceUrl]);

  function preview(next: string): void {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.setVirtualMovement(0, 0);
    runtime.setTouchAction('sprint', false);
    runtime.setLocomotionMode(next === '飞行' ? 'fly' : 'ground');
    if (next === '行走' || next === '跑步') runtime.setVirtualMovement(0, 1);
    if (next === '跑步') runtime.setTouchAction('sprint', true);
    if (next === '跳跃') { runtime.setTouchAction('jump', true); runtime.setTouchAction('jump', false); }
    if (next === '返回起点') runtime.reset();
    setAction(next === '返回起点' ? '站立' : next);
  }

  const loading = snapshot.avatarAnimationMode === 'loading';
  const failed = Boolean(error) || snapshot.avatarAnimationMode === 'error';
  const label = snapshot.avatarAnimationMode === 'auto-skeleton' ? '已自动适配'
    : snapshot.avatarAnimationMode === 'shared-skeleton' ? '共享漫游动作'
      : snapshot.avatarAnimationMode === 'embedded' ? '模型自带动画'
        : snapshot.avatarAnimationMode === 'static' ? '静态人物'
          : loading ? '正在加载和适配…' : failed ? '人物不可用' : '程序步态';
  return (
    <dialog ref={dialogRef} className="manual-roam-avatar-preview" role="dialog" aria-labelledby="avatar-preview-title"
      onKeyDownCapture={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      }}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <header><div><h2 id="avatar-preview-title">人物动作预览</h2><p>{name}</p></div>
        <button type="button" onClick={onClose} aria-label="关闭人物预览">关闭</button></header>
      <canvas ref={canvasRef} tabIndex={0} aria-label="人物动作预览画面" />
      <div className="manual-roam-avatar-preview-actions" aria-label="预览动作">
        {['站立', '行走', '跑步', '跳跃', '飞行', '返回起点'].map(value => <button type="button" key={value}
          disabled={loading || failed} aria-pressed={value === action} onClick={() => preview(value)}>{value}</button>)}
      </div>
      <div className="manual-roam-avatar-preview-status" role="status">
        <strong>{label}</strong><span>{error ?? snapshot.statusMessage ?? '可查看不同动作，确认人物外观与关节活动。'}</span>
      </div>
      <footer><p>右键拖动查看转身；WASD 移动、Shift 跑步、Space 跳跃，飞行时 Q/E 升降。</p>
        {onApply ? <button type="button" disabled={loading || failed} onClick={onApply}>应用此人物</button> : null}</footer>
    </dialog>
  );
}
