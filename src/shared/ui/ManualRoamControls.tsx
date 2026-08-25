import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type {
  ManualRoamSnapshot,
  ManualRoamTouchAction,
} from '../../runtime/roam/ManualRoamRuntime';
import type {
  ManualRoamConfig,
  ManualRoamLocomotionMode,
  ManualRoamViewMode,
} from '../../runtime/roam/manualRoamCore';
import '../../styles/manual-roam-controls.css';

type ManualRoamControlsProps = {
  snapshot: ManualRoamSnapshot;
  onEnabledChange: (enabled: boolean) => void;
  onViewModeChange: (viewMode: ManualRoamViewMode) => void;
  onLocomotionModeChange: (mode: ManualRoamLocomotionMode) => void;
  onConfigChange: (patch: Partial<ManualRoamConfig>) => void;
  onDebugCollidersChange: (visible: boolean) => void;
  onPointerLock: () => void;
  onReset: () => void;
  onVirtualMove: (right: number, forward: number) => void;
  onTouchAction: (action: ManualRoamTouchAction, pressed: boolean) => void;
};

const DEFAULT_MOUSE_SENSITIVITY = 0.0025;
const DEFAULT_TOUCH_SENSITIVITY = 0.004;
const JOYSTICK_RADIUS_PX = 42;

/** 运行预览和 Viewer 共用的漫游面板；触摸设备额外显示摇杆及跳跃/升降按钮。 */
export function ManualRoamControls(props: ManualRoamControlsProps) {
  const { snapshot } = props;
  const [collapsed, setCollapsed] = useState(() => (
    typeof window !== 'undefined'
    && (
      window.matchMedia('(hover: none) and (pointer: coarse)').matches
      || window.matchMedia('(max-width: 720px)').matches
    )
  ));
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const joystickPointerIdRef = useRef<number | null>(null);
  const cleanupCallbacksRef = useRef({
    onTouchAction: props.onTouchAction,
    onVirtualMove: props.onVirtualMove,
  });
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });

  cleanupCallbacksRef.current = {
    onTouchAction: props.onTouchAction,
    onVirtualMove: props.onVirtualMove,
  };

  useEffect(() => () => {
    const callbacks = cleanupCallbacksRef.current;
    callbacks.onVirtualMove(0, 0);
    for (const action of ['jump', 'ascend', 'descend', 'sprint'] as const) {
      callbacks.onTouchAction(action, false);
    }
  }, []);

  function updateJoystick(event: PointerEvent<HTMLDivElement>): void {
    const element = joystickRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const rawX = event.clientX - (rect.left + rect.width / 2);
    const rawY = event.clientY - (rect.top + rect.height / 2);
    const magnitude = Math.hypot(rawX, rawY);
    const scale = magnitude > JOYSTICK_RADIUS_PX ? JOYSTICK_RADIUS_PX / magnitude : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    setJoystickOffset({ x, y });
    props.onVirtualMove(x / JOYSTICK_RADIUS_PX, -y / JOYSTICK_RADIUS_PX);
  }

  function handleJoystickDown(event: PointerEvent<HTMLDivElement>): void {
    joystickPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    updateJoystick(event);
  }

  function handleJoystickMove(event: PointerEvent<HTMLDivElement>): void {
    if (joystickPointerIdRef.current !== event.pointerId) return;
    event.stopPropagation();
    updateJoystick(event);
  }

  function releaseJoystick(event: PointerEvent<HTMLDivElement>): void {
    if (joystickPointerIdRef.current !== event.pointerId) return;
    joystickPointerIdRef.current = null;
    setJoystickOffset({ x: 0, y: 0 });
    props.onVirtualMove(0, 0);
    event.stopPropagation();
  }

  function bindTouchAction(action: ManualRoamTouchAction) {
    return {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.stopPropagation();
        props.onTouchAction(action, true);
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        props.onTouchAction(action, false);
      },
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        props.onTouchAction(action, false);
      },
      onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        props.onTouchAction(action, false);
      },
    };
  }

  const rotationMultiplier = snapshot.config.mouseSensitivity / DEFAULT_MOUSE_SENSITIVITY;
  const animationLabel = snapshot.avatarAnimationMode === 'embedded'
    ? '模型动画'
    : snapshot.avatarAnimationMode === 'procedural'
      ? '程序步态'
      : snapshot.avatarAnimationMode === 'loading'
        ? '模型加载中'
        : '模型异常';

  return (
    <>
      <section className={`manual-roam-controls${collapsed ? ' is-collapsed' : ''}`} aria-label="手动漫游">
        <header>
          <button
            aria-expanded={!collapsed}
            className="manual-roam-controls-toggle"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? '展开手动漫游控制器' : '收起手动漫游控制器'}
            type="button"
          >
            <span aria-hidden="true" className={snapshot.enabled ? 'is-active' : ''}>●</span>
            <strong>手动漫游</strong>
            <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          </button>
        </header>
        {!collapsed ? (
          <div className="manual-roam-controls-body">
            <div className="manual-roam-primary-row">
              <button
                className={snapshot.enabled ? 'is-stop' : 'is-start'}
                onClick={() => props.onEnabledChange(!snapshot.enabled)}
                type="button"
              >
                {snapshot.enabled ? '结束漫游' : '开始漫游'}
              </button>
              <button disabled={!snapshot.enabled} onClick={props.onReset} title="恢复漫游初始位置" type="button">
                复位
              </button>
              <button
                aria-pressed={snapshot.pointerLocked}
                disabled={!snapshot.enabled}
                onClick={props.onPointerLock}
                title="锁定鼠标视角"
                type="button"
              >
                {snapshot.pointerLocked ? '已锁定' : '锁定'}
              </button>
            </div>

            <div className="manual-roam-status" aria-live="polite">
              <span>{snapshot.enabled ? snapshot.grounded || snapshot.locomotionMode === 'fly' ? '运行中' : '下落中' : '待机'}</span>
              <span>{animationLabel}</span>
              {snapshot.gamepadConnected ? <span>手柄</span> : null}
            </div>

            <div className="manual-roam-segments" aria-label="视角模式">
              <button
                aria-pressed={snapshot.viewMode === 'firstPerson'}
                onClick={() => props.onViewModeChange('firstPerson')}
                type="button"
              >
                第一人称
              </button>
              <button
                aria-pressed={snapshot.viewMode === 'thirdPerson'}
                onClick={() => props.onViewModeChange('thirdPerson')}
                type="button"
              >
                第三人称
              </button>
            </div>

            <div className="manual-roam-segments" aria-label="移动模式">
              <button
                aria-pressed={snapshot.locomotionMode === 'ground'}
                onClick={() => props.onLocomotionModeChange('ground')}
                type="button"
              >
                地面
              </button>
              <button
                aria-pressed={snapshot.locomotionMode === 'fly'}
                onClick={() => props.onLocomotionModeChange('fly')}
                type="button"
              >
                飞行
              </button>
            </div>

            <label className="manual-roam-slider">
              <span>移动速度</span>
              <input
                max="8"
                min="0.5"
                onChange={(event) => {
                  const walkSpeed = Number(event.target.value);
                  props.onConfigChange({ walkSpeed, runSpeed: walkSpeed * 2 });
                }}
                step="0.1"
                type="range"
                value={snapshot.config.walkSpeed}
              />
              <output>{snapshot.config.walkSpeed.toFixed(1)}</output>
            </label>
            <label className="manual-roam-slider">
              <span>旋转灵敏度</span>
              <input
                max="2.5"
                min="0.4"
                onChange={(event) => {
                  const multiplier = Number(event.target.value);
                  props.onConfigChange({
                    mouseSensitivity: DEFAULT_MOUSE_SENSITIVITY * multiplier,
                    touchLookSensitivity: DEFAULT_TOUCH_SENSITIVITY * multiplier,
                  });
                }}
                step="0.1"
                type="range"
                value={rotationMultiplier}
              />
              <output>{rotationMultiplier.toFixed(1)}x</output>
            </label>
            {snapshot.viewMode === 'thirdPerson' ? (
              <label className="manual-roam-slider">
                <span>跟随距离</span>
                <input
                  max="8"
                  min="0.8"
                  onChange={(event) => props.onConfigChange({ thirdPersonDistance: Number(event.target.value) })}
                  step="0.1"
                  type="range"
                  value={snapshot.config.thirdPersonDistance}
                />
                <output>{snapshot.config.thirdPersonDistance.toFixed(1)}m</output>
              </label>
            ) : null}
            <label className="manual-roam-debug-toggle">
              <input
                checked={snapshot.debugColliders}
                onChange={(event) => props.onDebugCollidersChange(event.target.checked)}
                type="checkbox"
              />
              <span>碰撞体调试</span>
            </label>
            {snapshot.statusMessage ? <p className="manual-roam-message">{snapshot.statusMessage}</p> : null}
          </div>
        ) : null}
      </section>

      {snapshot.enabled ? (
        <div className="manual-roam-touch-controls" aria-label="触摸漫游控制">
          <div
            aria-label="移动摇杆"
            className="manual-roam-joystick"
            onPointerCancel={releaseJoystick}
            onPointerDown={handleJoystickDown}
            onLostPointerCapture={releaseJoystick}
            onPointerMove={handleJoystickMove}
            onPointerUp={releaseJoystick}
            ref={joystickRef}
            role="application"
          >
            <span style={{ transform: `translate(${joystickOffset.x}px, ${joystickOffset.y}px)` }} />
          </div>
          <div className="manual-roam-touch-actions">
            {snapshot.locomotionMode === 'ground' ? (
              <button {...bindTouchAction('jump')} type="button">跳</button>
            ) : (
              <>
                <button {...bindTouchAction('ascend')} type="button">升</button>
                <button {...bindTouchAction('descend')} type="button">降</button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
