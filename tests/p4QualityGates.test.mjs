import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ESLint } from 'eslint';
import { containsAsciiControlCharacters, containsAsciiControlCharactersOr, replaceAsciiControlCharacters } from '../electron/shared/asciiControlCharacters.ts';
import { readSkyboxTextureBlob } from '../src/runtime/babylon/skyboxTextureLoad.ts';

// 验证实际生效的配置，防止后续覆盖层将正式门禁重新降为告警。
test('renderer和Electron正式启用未使用局部检查，四项正确性规则均为error', async () => {
  for (const name of ['tsconfig.json', 'tsconfig.node.json']) {
    const config = JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
    assert.equal(config.compilerOptions.noUnusedLocals, true, name);
  }
  const eslint = new ESLint();
  for (const file of ['src/editor/panels/SceneViewPanel.tsx', 'electron/ipc/assetIpc.ts']) {
    const config = await eslint.calculateConfigForFile(file);
    for (const rule of ['react-hooks/exhaustive-deps', 'preserve-caught-error', 'no-useless-assignment', 'no-unsafe-finally']) {
      assert.equal(config.rules[rule][0], 2, file + ': ' + rule);
    }
  }
});

// 原规则是严格C0范围；穷举码元，避免用Unicode控制类扩大接受/拒绝边界。
test('路径控制字符保持C0精确范围、混合字符和替换规则', () => {
  const oldControl = /[\x00-\x1f]/;
  const oldReplacement = /[\x00-\x1f]/g;
  const additional = '<>:"/\\|?*';
  for (let code = 0; code <= 65535; code++) {
    const value = '前缀' + String.fromCharCode(code) + 'suffix';
    assert.equal(containsAsciiControlCharacters(value), oldControl.test(value), 'code=' + code);
    assert.equal(containsAsciiControlCharactersOr(value, additional), oldControl.test(value) || additional.includes(String.fromCharCode(code)), 'mixed=' + code);
    assert.equal(replaceAsciiControlCharacters(value, '_'), value.replace(oldReplacement, '_'), 'replace=' + code);
  }
  assert.equal(containsAsciiControlCharacters('正常😀\x7f\x80\x9f'), false);
  assert.equal(replaceAsciiControlCharacters('a\0b\nc', '_'), 'a_b_c');
});

// 上游取消失败不能覆盖既有HTTP/大小错误，且应保留传给cancel的原错误对象。
test('天空盒提前拒绝时，cancel失败仍返回同一原始读取错误', async (t) => {
  for (const status of [503, 200]) {
    let original;
    const stream = new ReadableStream({ cancel(reason) { original = reason; throw new Error('cancel-failure'); } }, { highWaterMark: 0 });
    const response = new Response(stream, { status, headers: { 'Content-Length': status === 200 ? '9' : '1' } });
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(readSkyboxTextureBlob('https://example.test/skybox.exr', new AbortController().signal, 8), error => {
      assert.equal(error, original);
      assert.match(error.message, status === 503 ? /HTTP 503/ : /读取上限/);
      return true;
    });
    t.mock.restoreAll();
  }
});
