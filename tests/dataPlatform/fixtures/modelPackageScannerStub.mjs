export async function scanModelPackage() {
  return { asset: null, skipped: { reason: 'empty' } };
}

export async function validateEnvironmentGlbFile() {
  return true;
}
