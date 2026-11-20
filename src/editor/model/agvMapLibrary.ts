import { AGV_MAP_SCHEMA_VERSION, type AgvMapDefinition } from './agvMap.ts';
import type { AgvMapComponent } from './components';

/** 内置示例地图按 ID 访问。 */
export const BUILT_IN_AGV_MAPS: AgvMapDefinition[] = [
  {
    schemaVersion: AGV_MAP_SCHEMA_VERSION,
    id: 'demo-production-line',
    name: '示例地图 · 单层产线',
    nodes: [
      { id: 'P01', name: '原料入库', businessType: 'pickup', x: 0, y: 0 },
      { id: 'P02', name: '加工工位', businessType: 'station', x: 12, y: 0 },
      { id: 'P03', name: '质检工位', businessType: 'station', x: 12, y: 8 },
      { id: 'P04', name: '成品出库', businessType: 'dropoff', x: 0, y: 8 },
      { id: 'C01', name: '充电桩', businessType: 'charging', x: -4, y: 0 },
    ],
    tracks: [
      { id: 'T01', fromNodeId: 'P01', toNodeId: 'P02', bidirectional: true },
      { id: 'T02', fromNodeId: 'P02', toNodeId: 'P03' },
      { id: 'T03', fromNodeId: 'P03', toNodeId: 'P04', bidirectional: true },
      { id: 'T04', fromNodeId: 'P04', toNodeId: 'P01' },
      { id: 'T05', fromNodeId: 'P01', toNodeId: 'C01' },
      {
        id: 'T06',
        fromNodeId: 'P02',
        toNodeId: 'P04',
        name: '检修绕行路线',
        points: [{ x: 12, y: 0 }, { x: 16, y: 2 }, { x: 16, y: 6 }, { x: 12, y: 10 }, { x: 0, y: 8 }],
      },
    ],
  },
  {
    schemaVersion: AGV_MAP_SCHEMA_VERSION,
    id: 'demo-loop-dispatch',
    name: '示例地图 · 环形调度',
    nodes: [
      { id: 'A', name: '装货区', businessType: 'pickup', x: -10, y: -6 },
      { id: 'B', name: '一号工位', businessType: 'station', x: 10, y: -6 },
      { id: 'C', name: '二号工位', businessType: 'station', x: 10, y: 6 },
      { id: 'D', name: '卸货区', businessType: 'dropoff', x: -10, y: 6 },
      { id: 'W', name: '等待区', businessType: 'waiting', x: 0, y: 0 },
    ],
    tracks: [
      { id: 'AB', fromNodeId: 'A', toNodeId: 'B', bidirectional: true },
      { id: 'BC', fromNodeId: 'B', toNodeId: 'C' },
      { id: 'CD', fromNodeId: 'C', toNodeId: 'D', bidirectional: true },
      { id: 'DA', fromNodeId: 'D', toNodeId: 'A' },
      { id: 'AW', fromNodeId: 'A', toNodeId: 'W' },
      { id: 'WC', fromNodeId: 'W', toNodeId: 'C' },
      { id: 'BW', fromNodeId: 'B', toNodeId: 'W' },
      { id: 'WD', fromNodeId: 'W', toNodeId: 'D' },
    ],
  },
];

export function getBuiltInAgvMap(mapId: string | null): AgvMapDefinition | null {
  if (!mapId) return null;
  return BUILT_IN_AGV_MAPS.find(map => map.id === mapId) ?? null;
}

/** 导入地图属于当前产生器，内置地图仍通过固定 ID 读取。 */
export function getAgvMapDefinition(component: AgvMapComponent): AgvMapDefinition | null {
  const { mapId, importedMap } = component;
  return importedMap?.id === mapId ? importedMap : getBuiltInAgvMap(mapId);
}
