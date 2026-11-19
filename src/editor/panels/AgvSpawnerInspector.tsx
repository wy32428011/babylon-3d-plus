import type { AgvMapComponent, DeviceSpawnerComponent } from '../model/components';
import {
  AGV_MAP_SCALE_MAX,
  AGV_MAP_SCALE_MIN,
  AGV_MAP_SCENE_AXES,
  getAgvMapSceneAxisBase,
  type AgvMapSceneAxis,
} from '../model/agvMap';
import { BUILT_IN_AGV_MAPS, getBuiltInAgvMap } from '../model/agvMapLibrary';
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

type AgvSpawnerInspectorProps = {
  spawner: DeviceSpawnerComponent;
  map: AgvMapComponent;
  disabled?: boolean;
};

export function AgvSpawnerInspector({ spawner, map, disabled = false }: AgvSpawnerInspectorProps) {
  const updateSelectedAgvMap = useEditorStore(state => state.updateSelectedAgvMap);
  const selectedMap = getBuiltInAgvMap(map.mapId);

  function commitMap(patch: Partial<AgvMapComponent>, label: string): void {
    if (disabled) return;
    updateSelectedAgvMap({ ...map, ...patch }, label);
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
      <DeviceSpawnerInspector component={spawner} disabled={disabled} />
      <fieldset className="transform-fieldset">
        <legend>AGV地图</legend>
        <label className="inspector-row">
          <span>地图选择</span>
          <select
            disabled={disabled}
            value={map.mapId ?? ''}
            onChange={event => commitMap({ mapId: event.target.value || null }, '选择AGV地图')}
          >
            <option value="">未选择</option>
            {BUILT_IN_AGV_MAPS.map(definition => (
              <option key={definition.id} value={definition.id}>{definition.name}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled title="CAD 地图上传与转换将在后续版本提供">地图上传（后续版本）</button>
        {map.mapId && !selectedMap ? <p className="telemetry-runtime-error">所选地图不存在，请重新选择。</p> : null}
        <label className="inspector-row">
          <span>地图轨迹展示</span>
          <input
            type="checkbox"
            disabled={disabled || !selectedMap}
            checked={map.showTrajectories}
            onChange={event => commitMap({ showTrajectories: event.target.checked }, '切换AGV地图轨迹')}
          />
        </label>
        <label className="inspector-row">
          <span>地图X轴映射</span>
          <select
            disabled={disabled}
            value={map.xAxis}
            onChange={event => commitMap({ xAxis: event.target.value as AgvMapSceneAxis }, '更新AGV地图X轴映射')}
          >
            {renderAxisOptions(map.yAxis)}
          </select>
        </label>
        <label className="inspector-row">
          <span>地图Y轴映射</span>
          <select
            disabled={disabled}
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
            disabled={disabled}
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
        <p className="muted">1 地图单位 = {map.scale} 米；调整比例尺会立即更新轨迹范围。</p>
        <p className="muted">AGV产生器的位置就是地图 (0,0)，默认地图 X/Y 分别映射到场景 X/Z。</p>
        {selectedMap ? <p className="muted">业务节点：{selectedMap.nodes.length}，运行轨迹：{selectedMap.tracks.length}</p> : null}
      </fieldset>
    </>
  );
}
