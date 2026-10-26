import { useMemo } from 'react';
import { getSceneLightingBakeSignatureCached, requiresSceneLightingBake } from '../../../electron/shared/sceneLightingBakeContract';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import { useEditorStore } from '../store/editorStore';
import { CollapsibleFieldset } from '../ui/CollapsibleFieldset';
import { LightingManagerBadge } from './LightingBakeManagerWidgets';
import './lighting-bake-manager.css';

/** Inspector 只提供摘要，配置和任务都进入同一个全局管理器。 */
export function LightingBakeSettingsPanel({ readOnly = false }: { readOnly?: boolean }) {
  const scene = useEditorStore(state => state.scene);
  const status = useEditorStore(state => state.lightingBakeStatus);
  const request = useEditorStore(state => state.lightingBakeRequest);
  const open = useEditorStore(state => state.openLightingManager);
  const lighting = useMemo(() => getSceneLightingConfig(scene), [scene]);
  const signature = useMemo(() => getSceneLightingBakeSignatureCached(scene), [scene]);
  const result = lighting.result;
  const label = request ? '任务进行中' : !requiresSceneLightingBake(scene) ? '无需静态烘焙'
    : result && result.signature !== signature ? '已过期'
      : status.phase === 'error' ? '更新失败' : result ? '可用' : '未烘焙';
  return <CollapsibleFieldset title="光照与烘焙" className="lighting-manager-summary">
    <dl><div><dt>主光来源</dt><dd>{lighting.main.source === 'managed' ? '统一主光' : '场景方向光'}</dd></div>
      <div><dt>状态</dt><dd><LightingManagerBadge tone={label === '可用' ? 'success' : label === '已过期' || label === '更新失败' ? 'warning' : 'neutral'}>{label}</LightingManagerBadge></dd></div></dl>
    <button type="button" className="lighting-manager-open-button" onClick={() => open({ tab: 'overview' })}>打开管理器</button>
    {readOnly && <p>运行预览中，可查看配置或停止预览。</p>}
  </CollapsibleFieldset>;
}
