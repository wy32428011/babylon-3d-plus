import './LightWallFenceInspector.css';
import { useEffect, useState } from 'react';
import type { LightWallFenceConfig, PoiEffectComponent } from '../model/components';
import { createDefaultLightWallFence, LIGHT_WALL_HEIGHT_MAX, LIGHT_WALL_HEIGHT_MIN, parseLightWallPoints } from '../model/lightWallFence';
import { POI_EFFECT_SPEED_MAX } from '../model/poiEffect';

type Props = {
  component: PoiEffectComponent;
  disabled: boolean;
  onChange: (component: PoiEffectComponent, label: string) => void;
};

export function LightWallFenceInspector({ component, disabled, onChange }: Props) {
  const config = component.lightWall ?? createDefaultLightWallFence();
  const savedOutline = config.points.map(p => `${p.x}, ${p.z}`).join('\n');
  const [outline, setOutline] = useState(savedOutline);
  const [error, setError] = useState('');
  const [width, setWidth] = useState('10');
  const [depth, setDepth] = useState('8');

  // 仅已提交轮廓改变时同步；调整外观参数不会清掉尚未应用的轮廓草稿。
  useEffect(() => { setOutline(savedOutline); setError(''); }, [savedOutline]);

  function commit(patch: Partial<LightWallFenceConfig>, label: string) {
    if (!disabled) onChange({ ...component, lightWall: { ...config, ...patch } }, label);
  }

  function applyOutline() {
    try {
      const points = parseLightWallPoints(outline);
      commit({ points }, '更新光墙围栏轮廓');
      setOutline(points.map(p => `${p.x}, ${p.z}`).join('\n'));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '轮廓格式无效。'); }
  }

  function createRectangle() {
    const x = Number(width) / 2, z = Number(depth) / 2;
    if (!width || !depth || !Number.isFinite(x) || !Number.isFinite(z) || x < 0.05 || z < 0.05 || x > 100000 || z > 100000) {
      setError('矩形长宽需在 0.1–200000 米之间。'); return;
    }
    const points = [{ x: -x, z: -z }, { x, z: -z }, { x, z }, { x: -x, z }];
    commit({ points }, '生成矩形光墙围栏');
    setOutline(points.map(p => `${p.x}, ${p.z}`).join('\n'));
    setError('');
  }

  return <div className="light-wall-inspector">
    <label className="inspector-row"><span>围栏颜色</span>
      <input type="color" disabled={disabled} value={component.primaryColor} onChange={e => onChange({ ...component, primaryColor: e.target.value }, '更新围栏颜色')} />
    </label>
    <label className="number-row"><span>围栏高度 (m)</span>
      <input type="number" min={LIGHT_WALL_HEIGHT_MIN} max={LIGHT_WALL_HEIGHT_MAX} step="0.1" disabled={disabled} value={config.height}
        onChange={e => { if (e.target.value !== '') commit({ height: Number(e.target.value) }, '更新围栏高度'); }} />
    </label>
    <label className="number-row"><span>透明度 (%)</span>
      <input type="number" min="0" max="100" step="1" disabled={disabled} value={Math.round((1 - config.opacity) * 100)}
        onChange={e => { if (e.target.value !== '') commit({ opacity: 1 - Number(e.target.value) / 100 }, '更新围栏透明度'); }} />
    </label>
    <label className="number-row"><span>流动速度</span>
      <input type="number" min="0" max={POI_EFFECT_SPEED_MAX} step="0.1" disabled={disabled} value={component.speed}
        onChange={e => { if (e.target.value !== '') onChange({ ...component, speed: Number(e.target.value) }, '更新围栏流动速度'); }} />
    </label>
    <p className="muted">光带向上流动，速度为 0 时静止；透明度为 100% 时完全透明。</p>
    <details open>
      <summary>建筑外围轮廓</summary>
      <p className="muted">在局部 X/Z 平面按顺序填写建筑外围拐点，每行 X, Z（米），首尾自动闭合。支持 3–128 个点和凹多边形。</p>
      <label className="number-row"><span>矩形长度 X (m)</span><input type="number" min="0.1" max="200000" step="1" disabled={disabled} value={width} onChange={e => setWidth(e.target.value)} /></label>
      <label className="number-row"><span>矩形宽度 Z (m)</span><input type="number" min="0.1" max="200000" step="1" disabled={disabled} value={depth} onChange={e => setDepth(e.target.value)} /></label>
      <button type="button" disabled={disabled} onClick={createRectangle}>生成矩形轮廓</button>
      <label style={{ display: 'block', marginTop: 8 }}>轮廓顶点 (X, Z)
        <textarea aria-label="轮廓顶点 (X, Z)" rows={6} maxLength={8192} disabled={disabled} value={outline}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }} onChange={e => { setOutline(e.target.value); setError(''); }} />
      </label>
      <button type="button" disabled={disabled || outline === savedOutline} onClick={applyOutline}>应用轮廓</button>
      {error && <p role="alert">{error}</p>}
      {outline !== savedOutline && !error && <p className="muted">轮廓有未应用的修改。</p>}
    </details>
    <p className="muted">位置为围栏底部锚点。用变换工具平移、旋转或缩放，使轮廓贴合建筑；缩放也会影响实际高度。</p>
  </div>;
}
