import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 合批 conveyor 遥测代理的创建门槛必须与真实模型的遥测解析语义一致：
 * 真实模型无显式 telemetryBinding 时按 assetCode 走默认绑定（resolveSpecializedTelemetryBinding），
 * devType 以 meta.json dataDriven 声明为准（文件名关键词只是兜底）。代理创建若更严格，
 * 合批实例会彻底失去遥测身份（订阅/刷出/交付全部静默失效）。
 */
function readProxySyncBody(): string {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  const start = source.indexOf('private syncModelArrayTelemetryProxies(): void');
  assert.notEqual(start, -1, 'SceneRuntime 必须存在 syncModelArrayTelemetryProxies');
  return source.slice(start, source.indexOf('private createModelArrayTelemetryProxy', start));
}

test('遥测代理创建不得要求显式 telemetryBinding 组件（与真实模型默认绑定语义一致）', () => {
  const body = readProxySyncBody();
  assert.doesNotMatch(body, /!binding\b/, '代理创建不得以缺失 binding 为由跳过实例');
  assert.match(body, /binding\?\.enabled === false/, '仅显式禁用遥测的实例才跳过代理创建');
});

test('遥测代理 conveyor 识别接受 dataDriven devType 声明，文件名关键词仅作兜底', () => {
  const body = readProxySyncBody();
  assert.match(body, /dataDrivenConfig\?\.device\?\.devType/, '必须读取 dataDrivenConfig 的 devType 声明');
  assert.match(body, /devType !== 'conveyor' && !isConveyorModelAsset/, 'devType 未声明时才回退文件名关键词识别');
});
