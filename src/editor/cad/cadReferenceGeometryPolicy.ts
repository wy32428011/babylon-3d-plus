/** 单个批次保持 Uint16 索引，并限制 Babylon 单次场景构建工作量。 */
export const CAD_REFERENCE_MAX_BATCH_POINTS = 60_000;
export const CAD_REFERENCE_MAX_BATCH_POLYLINES = 4_000;
/** 包含唯一 CPU/GPU 几何、实例矩阵和批次保守开销的分配前保护阈值。 */
export const CAD_REFERENCE_MAX_GEOMETRY_BYTES = 2 * 1024 ** 3;
