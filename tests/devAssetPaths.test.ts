import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolveDevAssetRoots, isAllowedDevAssetPath } from '../scripts/dev-asset-paths.ts';

test('explicit environment wins; .env.local is read without requiring a VITE client variable', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'babylon-dev-assets-'));
  try {
    writeFileSync(path.join(workspace, '.env.local'), 'STACKER_MODEL_LIBRARY_ROOT=./local-models\nPRIVATE_OTHER_VALUE=not-exported\n');
    assert.equal(resolveDevAssetRoots(workspace, 'development', { STACKER_MODEL_LIBRARY_ROOT: './explicit' }, () => false)[1], path.join(workspace, 'explicit'));
    assert.deepEqual(resolveDevAssetRoots(workspace, 'development', {}, () => false), [workspace, path.join(workspace, 'local-models')]);
  } finally { rmSync(workspace, { recursive: true }); }
});

test('legacy existing directory stays compatible; missing default falls back to workspace', () => {
  const workspace = path.resolve('output/dev-asset-path-test');
  assert.equal(resolveDevAssetRoots(workspace, 'development', {}, () => true)[1], path.resolve('F:/3d-models'));
  assert.deepEqual(resolveDevAssetRoots(workspace, 'development', {}, () => false), [workspace, workspace]);
});

test('root and descendants allowed; traversal, sibling prefixes and other volumes rejected', () => {
  const roots = [path.resolve('output/allowed-models')];
  assert.ok(isAllowedDevAssetPath(roots[0], roots));
  assert.ok(isAllowedDevAssetPath(path.join(roots[0], 'nested/a.glb'), roots));
  assert.equal(isAllowedDevAssetPath(path.join(roots[0], '../outside.glb'), roots), false);
  assert.equal(isAllowedDevAssetPath(roots[0] + '-sibling/a.glb', roots), false);
  assert.equal(isAllowedDevAssetPath('Z:/outside/a.glb', roots), false);
});
