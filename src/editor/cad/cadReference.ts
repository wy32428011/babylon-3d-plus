/** 同步兼容入口；生产纯几何与缓存调用使用 Core，避免提前加载精确解析器。 */
export * from './cadReferenceCore';
export { parseCadReferenceDxf } from './cadReferenceParser';
