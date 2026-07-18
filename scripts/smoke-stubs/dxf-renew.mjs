/** SceneRuntime smoke 不执行 CAD 解析；若误触该路径则立即失败。 */
export function parseString() {
  throw new Error('Shelf 共享实例 smoke 不应调用 DXF 解析。');
}
