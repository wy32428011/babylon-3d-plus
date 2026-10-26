import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { inspectSkyboxEnvironmentBytes, normalizeSkyboxEnvironmentResource, skyboxEnvironmentMatchesSource,
  withoutSkyboxEnvironment, SKYBOX_ENVIRONMENT_RECIPE } from '../../electron/shared/sceneSkyboxContract.ts';
import { skyboxEnvironmentFixture, changeSkyboxEnvironmentHeader } from '../helpers/skyboxEnvironmentFixture.mjs';

const bytes = skyboxEnvironmentFixture();
const resource = () => ({ version: 1, format: 'env', sourceSha256: 'a'.repeat(64), sourceRevision: 'mtime-size',
  recipeKey: SKYBOX_ENVIRONMENT_RECIPE, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
  faceSize: 256, sourceUrl: 'editor-asset://local/F%3A%2Fcache%2Fsky.env' });

test('原生 ENV 校验完整六面/Mip/PNG/球谐并报告实际尺寸', () => {
  assert.deepEqual(inspectSkyboxEnvironmentBytes(bytes, 256), { faceSize: 256, mipLevels: 9, imageCount: 54 });
  assert.throws(() => inspectSkyboxEnvironmentBytes(bytes, 512), /面尺寸/);
  assert.throws(() => inspectSkyboxEnvironmentBytes(bytes.subarray(0, bytes.length - 1)), /越界/);
});

test('拒绝 ENV 魔数、版本、编码、过大面尺寸、缺面、重叠和非有限球谐', () => {
  const invalid = bytes.slice(); invalid[0] = 0;
  assert.throws(() => inspectSkyboxEnvironmentBytes(invalid), /文件头/);
  for (const change of [
    (h: any) => { h.version = 3; },
    (h: any) => { h.imageType = 'image/webp'; },
    (h: any) => { h.width = 8192; },
    (h: any) => { h.specular.mipmaps.pop(); },
    (h: any) => { h.specular.mipmaps[1].position = 0; },
    (h: any) => { h.specular.mipmaps[0].length = Number.MAX_SAFE_INTEGER; },
    (h: any) => { h.irradiance.xx[0] = null; },
  ]) assert.throws(() => inspectSkyboxEnvironmentBytes(changeSkyboxEnvironmentHeader(bytes, change)));
});

test('源身份、产物身份、配方与分辨率独立验证', () => {
  const env = normalizeSkyboxEnvironmentResource(resource());
  assert.notEqual(env.sourceSha256, env.sha256);
  assert.equal(skyboxEnvironmentMatchesSource({ resolution: 256, assetRevision: 'mtime-size' }, env), true);
  assert.equal(skyboxEnvironmentMatchesSource({ resolution: 512, assetRevision: 'mtime-size' }, env), false);
  assert.equal(skyboxEnvironmentMatchesSource({ resolution: 256, assetRevision: 'new-version' }, env), false);
  assert.equal(skyboxEnvironmentMatchesSource({ resolution: 256, assetRevision: 'A'.repeat(64) }, env), true);
  assert.throws(() => normalizeSkyboxEnvironmentResource({ ...resource(), recipeKey: 'other' }));
  assert.throws(() => normalizeSkyboxEnvironmentResource({ ...resource(), sourceUrl: 'javascript:alert(1)' }));
  assert.throws(() => normalizeSkyboxEnvironmentResource({ ...resource(), sourceUrl: 'https://user:secret@host.test/a.env' }));
  assert.throws(() => normalizeSkyboxEnvironmentResource({ ...resource(), sourceUrl: 'https://host.test/a.hdr' }));
});

test('资源描述不执行 accessor，派生字段不污染旧 GI 输入', () => {
  let executed = false;
  const value = resource();
  Object.defineProperty(value, 'sha256', { get() { executed = true; return 'a'.repeat(64); } });
  assert.throws(() => normalizeSkyboxEnvironmentResource(value), /数据属性/);
  assert.equal(executed, false);
  const before = { format: 'hdr', sourceUrl: 'original', businessExtension: 42 };
  assert.deepEqual(withoutSkyboxEnvironment({ ...before, environment: resource(), sourceAvailable: false }), before);
  assert.equal(withoutSkyboxEnvironment(before), before);
});
