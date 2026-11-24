import type { AgvMapComponent, DeviceSpawnerComponent } from '../model/components';
import {
  AGV_MAP_SCALE_MAX,
  AGV_MAP_NODE_RADIUS_MAX,
  AGV_MAP_NODE_RADIUS_MIN,
  AGV_ROUTE_HIGHLIGHT_STYLES,
  AGV_MAP_SCALE_MIN,
  AGV_MAP_SCENE_AXES,
  getAgvMapSceneAxisBase,
  type AgvMapSceneAxis,
  type AgvRouteHighlightConfig,
  type AgvRouteHighlightStyle,
} from '../model/agvMap';
import { BUILT_IN_AGV_MAPS, getAgvMapDefinition } from '../model/agvMapLibrary';
import { useEditorStore } from '../store/editorStore';
import { DeviceSpawnerInspector } from './DeviceSpawnerInspector';

const AXIS_LABELS: Record<AgvMapSceneAxis, string> = {
  x: '场景 +X',
  y: '场景 +Y',
  z: '场景 +Z',
  '-x': '场景 -X',
  '-y': '场景 -Y',
  '-z': '场景 -Z',
};

const ROUTE_STYLE_LABELS: Record<AgvRouteHighlightStyle, string> = {
  'flow-path': '流光路径',
  'flow-arrows': '流动箭头',
  'path-reveal': '路径逐段点亮',
  'pipe-flow': '管道流动',
};

type AgvSpawnerInspectorProps = {
  entityId: string;
  spawner: DeviceSpawnerComponent;
  map: AgvMapComponent;
  disabled?: boolean;
};

export function AgvSpawnerInspector({ entityId, spawner, map, disabled = false }: AgvSpawnerInspectorProps) {
  const updateSelectedAgvMap = useEditorStore(state => state.updateSelectedAgvMap);
  const importCadReference = useEditorStore(state => state.importCadReference);
  const importingCad = useEditorStore(state => Boolean(state.cadImportProgress?.active));
  const selectedMap = getAgvMapDefinition(map);
  const mapEditingDisabled = disabled || importingCad;

  function commitMap(patch: Partial<AgvMapComponent>, label: string): void {
    if (mapEditingDisabled) return;
    updateSelectedAgvMap({ ...map, ...patch }, label);
  }

  function commitRouteHighlight(patch: Partial<AgvRouteHighlightConfig>, label: string): void {
    commitMap({ routeHighlight: { ...map.routeHighlight, ...patch } }, label);
  }

  function exportMap(): void {
    if (!selectedMap) return;
    const json = JSON.stringify(selectedMap, null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedMap.name.replace(/[<>:"/\\|?*]/g, '-')}.agv-map.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderAxisOptions(otherAxis: AgvMapSceneAxis) {
    const otherBase = getAgvMapSceneAxisBase(otherAxis);
    return AGV_MAP_SCENE_AXES.map(axis => (
      <option key={axis} value={axis} disabled={getAgvMapSceneAxisBase(axis) === otherBase}>
        {AXIS_LABELS[axis]}
      </option>
    ));
  }

  return (
    <>
      <DeviceSpawnerInspector component={spawner} disabled={disabled} agvOnly />
      <fieldset className="transform-fieldset">
        <legend>AGV地图</legend>
        <label className="inspector-row">
          <span>地图选择</span>
          <select
            disabled={mapEditingDisabled}
            value={map.mapId ?? ''}
            onChange={event => commitMap({ mapId: event.target.value || null }, '选择AGV地图')}
          >
            <option value="">未选择</option>
            {BUILT_IN_AGV_MAPS.map(definition => (
              <option key={definition.id} value={definition.id}>{definition.name}</option>
            ))}
            {map.importedMap ? <option value={map.importedMap.id}>{map.importedMap.name}</option> : null}
          </select>
        </label>
        <button type="button" disabled={mapEditingDisabled} onClick={() => void importCadReference(entityId)}>
          地图上传（DXF）
        </button>
        <button type="button" disabled={!selectedMap || importingCad} onClick={exportMap}>导出地图 JSON</button>
        {map.mapId && !selectedMap ? <p className="telemetry-runtime-error">所选地图不存在，请重新选择。</p> : null}
        <label className="inspector-row">
          <span>地图轨迹展示</span>
          <input
            type="checkbox"
            disabled={mapEditingDisabled || !selectedMap}
            checked={map.showTrajectories}
            onChange={event => commitMap({ showTrajectories: event.target.checked }, '切换AGV地图轨迹')}
          />
        </label>
        <label className="inspector-row">
          <span>整体地图底图</span>
          <input
            type="checkbox"
            disabled={mapEditingDisabled || selectedMap !== map.importedMap}
            checked={map.showBaseMap}
            onChange={event => commitMap({ showBaseMap: event.target.checked }, '切换AGV整体地图底图')}
          />
        </label>
        <p className="muted">底图开关仅控制上传的 DXF 线稿，不影响地图轨迹和任务路径高亮。</p>
        <label className="inspector-row">
          <span>地图X轴映射</span>
          <select
            disabled={mapEditingDisabled}
            value={map.xAxis}
            onChange={event => commitMap({ xAxis: event.target.value as AgvMapSceneAxis }, '更新AGV地图X轴映射')}
          >
            {renderAxisOptions(map.yAxis)}
          </select>
        </label>
        <label className="inspector-row">
          <span>地图Y轴映射</span>
          <select
            disabled={mapEditingDisabled}
            value={map.yAxis}
            onChange={event => commitMap({ yAxis: event.target.value as AgvMapSceneAxis }, '更新AGV地图Y轴映射')}
          >
            {renderAxisOptions(map.xAxis)}
          </select>
        </label>
        <label className="number-row">
          <span>比例尺</span>
          <input
            type="number"
            disabled={mapEditingDisabled}
            min={AGV_MAP_SCALE_MIN}
            max={AGV_MAP_SCALE_MAX}
            step="0.1"
            value={map.scale}
            onChange={event => {
              if (event.target.value === '') return;
              const scale = Number(event.target.value);
              if (Number.isFinite(scale)) commitMap({ scale }, '调整AGV地图比例尺');
            }}
          />
        </label>
        <label className="number-row">
          <span>节点触达半径 (m)</span>
          <input
            type="number"
            disabled={mapEditingDisabled}
            min={AGV_MAP_NODE_RADIUS_MIN}
            max={AGV_MAP_NODE_RADIUS_MAX}
            step="0.1"
            value={map.nodeRadius}
            onChange={event => {
              if (event.target.value === '') return;
              const nodeRadius = Number(event.target.value);
              if (Number.isFinite(nodeRadius)) commitMap({ nodeRadius }, '更新AGV节点触达半径');
            }}
          />
        </label>
        <p className="muted">1 地图单位 = {map.scale} 米；调整比例尺会立即更新轨迹范围。</p>
        <p className="muted">车辆进入不同节点的触达半径后，以该节点为起点、原任务终点为目标重新规划路线，不改变车辆实时位置。</p>
        <p className="muted">AGV产生器的位置就是地图 (0,0)，默认地图 X/Y 分别映射到场景 X/Z。</p>
        {selectedMap ? <p className="muted">业务节点：{selectedMap.nodes.length}，运行轨迹：{selectedMap.tracks.length}</p> : null}
      </fieldset>
      <fieldset className="transform-fieldset">
        <legend>任务路径高亮</legend>
        <label className="inspector-row">
          <span>启用路径高亮</span>
          <input
            type="checkbox"
            disabled={mapEditingDisabled}
            checked={map.routeHighlight.enabled}
            onChange={event => commitRouteHighlight({ enabled: event.target.checked }, '切换AGV任务路径高亮')}
          />
        </label>
        <label className="inspector-row">
          <span>路径特效样式</span>
          <select
            disabled={mapEditingDisabled || !map.routeHighlight.enabled}
            value={map.routeHighlight.style}
            onChange={event => commitRouteHighlight(
              { style: event.target.value as AgvRouteHighlightStyle },
              '更新AGV路径特效样式',
            )}
          >
            {AGV_ROUTE_HIGHLIGHT_STYLES.map(style => (
              <option key={style} value={style}>{ROUTE_STYLE_LABELS[style]}</option>
            ))}
          </select>
        </label>
        <label className="inspector-row">
          <span>未完成颜色</span>
          <input
            type="color"
            disabled={mapEditingDisabled || !map.routeHighlight.enabled}
            value={map.routeHighlight.remainingColor}
            onChange={event => commitRouteHighlight({ remainingColor: event.target.value }, '更新AGV未完成路径颜色')}
          />
        </label>
        <label className="number-row">
          <span>路径线宽 (m)</span>
          <input
            type="number"
            min={0.02}
            max={5}
            step={0.01}
            disabled={mapEditingDisabled || !map.routeHighlight.enabled}
            value={map.routeHighlight.width}
            onChange={event => {
              if (event.target.value === '') return;
              const width = Number(event.target.value);
              if (Number.isFinite(width)) commitRouteHighlight({ width }, '更新AGV路径线宽');
            }}
          />
        </label>
        <label className="number-row">
          <span>路径不透明度 (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            disabled={mapEditingDisabled || !map.routeHighlight.enabled}
            value={Number((map.routeHighlight.opacity * 100).toFixed(3))}
            onChange={event => {
              if (event.target.value === '') return;
              const opacity = Number(event.target.value);
              if (Number.isFinite(opacity)) commitRouteHighlight({ opacity: opacity / 100 }, '更新AGV路径不透明度');
            }}
          />
        </label>
        {map.routeHighlight.style !== 'path-reveal' ? <>
          <label className="number-row">
            <span>流动速度 (m/s)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              disabled={mapEditingDisabled || !map.routeHighlight.enabled}
              value={map.routeHighlight.speed}
              onChange={event => {
                if (event.target.value === '') return;
                const speed = Number(event.target.value);
                if (Number.isFinite(speed)) commitRouteHighlight({ speed }, '更新AGV路径流动速度');
              }}
            />
          </label>
          <p className="muted">箭头与流光按场景米制速度移动，不受任务路线长短影响；设为 0 可停止流动，数量仅控制显示密度。</p>
          <label className="number-row">
            <span>{map.routeHighlight.style === 'flow-arrows' ? '箭头数量' : '流光波段数量'}</span>
            <input
              type="number"
              min={1}
              max={64}
              step={1}
              disabled={mapEditingDisabled || !map.routeHighlight.enabled}
              value={map.routeHighlight.amount}
              onChange={event => {
                if (event.target.value === '') return;
                const amount = Number(event.target.value);
                if (Number.isFinite(amount)) commitRouteHighlight({ amount }, '更新AGV路径流动数量');
              }}
            />
          </label>
        </> : null}
        <p className="muted">小车当前地图坐标投影到任务路线，投影点之前的已行驶路径和箭头直接隐藏，仅显示到终点的剩余部分；不会改变 MQTT 实时位置。</p>
      </fieldset>
    </>
  );
}
