export function isSupportedSceneFilePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json');
}
