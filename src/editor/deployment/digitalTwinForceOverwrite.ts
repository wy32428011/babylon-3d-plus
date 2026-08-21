export function validateDigitalTwinForceOverwrite(
  versionConflict: boolean,
  forceOverwrite: boolean,
): string | null {
  return versionConflict && !forceOverwrite
    ? '远端已经产生新版本，请确认强制使用本地版本覆盖后再发布。'
    : null;
}
