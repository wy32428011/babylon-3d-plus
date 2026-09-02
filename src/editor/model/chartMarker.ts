import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import { createId } from '../../shared/ids';
import { DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS, DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS } from './dataPlatformScreen';

/** 空立标也具有完整实体身份，底边落在拖入场景的地面点。 */
export function createChartMarkerEntity(position: Vector3Data): Entity {
  return {
    id: createId('entity'),
    name: '图表立标',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { ...position, y: position.y + DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS / 2 },
        rotation: { x: Math.PI / 2, y: 0, z: 0 },
        scale: { x: DATA_PLATFORM_SCREEN_DEFAULT_WIDTH_METERS / 2, y: 1, z: DATA_PLATFORM_SCREEN_DEFAULT_HEIGHT_METERS / 2 },
      },
      meshRenderer: { meshKind: 'plane', materialColor: '#101827' },
      chartMarker: {},
    },
  };
}
