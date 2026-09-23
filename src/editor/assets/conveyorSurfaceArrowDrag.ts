import { BUILT_IN_ASSET_DRAG_MIME_TYPE, decodeBuiltInAssetDragPayload } from './AssetDatabase';
import { isConveyorSurfaceArrowStyle, type ConveyorSurfaceArrowsConfig } from '../model/conveyorSurfaceArrows';

type ArrowStyleDataTransfer = Pick<DataTransfer, 'types' | 'getData'> & { files: Pick<FileList, 'length'> };

/** 仅接受库内受支持的箭头样式，外部文件及其它资源不得被转换成输送面配置。 */
export function readConveyorSurfaceArrowStyleDrop(
  dataTransfer: ArrowStyleDataTransfer,
  disabled = false,
): ConveyorSurfaceArrowsConfig['style'] | null {
  if (disabled || dataTransfer.files.length > 0 || dataTransfer.types.includes('Files')
    || !dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE)) return null;
  const payload = decodeBuiltInAssetDragPayload(dataTransfer.getData(BUILT_IN_ASSET_DRAG_MIME_TYPE));
  return payload?.kind === 'poi-effect' && isConveyorSurfaceArrowStyle(payload.effectKind)
    ? payload.effectKind
    : null;
}
