import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ADVERTISED_BROKER = 'ws://192.168.18.100:8083/mqtt';
const CONNECT_TIMEOUT_MS = 5000, MAX_RECORDS = 10000, MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const sensitiveKey = /(?:password|passwd|passphrase|pwd|secret|token|authorization|apikey|accesskey|credential|privatekey|username)/i;
const inlineSensitive = /(?:["']?(?:password|passwd|passphrase|pwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|authorization|credential(?:s)?|api[_-]?key|access[_-]?key|private[_-]?key|username)["']?\s*[:=])|(?:bearer\s+[a-z\d._-]+)|(?:\w+:\/\/[^\s/:@]+:[^\s@]+@)|(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sensitiveText = text => inlineSensitive.test(text.replace(/\\u([a-f\d]{4})/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16))).replaceAll('\0', ''));

/** 敏感检测先于任何原文落盘；不能证明安全时也保守省略并保留顺序槽位。 */
export function inspectPayload(payload) {
  const bytes = Buffer.from(payload), scanText = bytes.toString('utf8');
  if (sensitiveText(scanText)) return { sensitive: true, reason: 'sensitive-key-or-credential-pattern' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { sensitive: false, text: null, format: 'binary-or-invalid-utf8' }; }
  let parsed;
  try { parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { return { sensitive: false, text, format: 'non-json' }; }
  const pending = [parsed]; let visited = 0;
  while (pending.length) {
    if (++visited > 100000) return { sensitive: true, reason: 'sensitive-inspection-budget' };
    const current = pending.pop();
    if (typeof current === 'string' && sensitiveText(current)) return { sensitive: true, reason: 'embedded-sensitive-pattern' };
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (sensitiveKey.test(key.replace(/[^a-z\d]/gi, '')) || /密码|口令|秘钥|密钥|令牌|凭据/.test(key)) return { sensitive: true, reason: 'sensitive-json-key' };
      pending.push(value);
    }
  }
  return { sensitive: false, text, format: text.charCodeAt(0) === 0xfeff ? 'json-with-utf8-bom' : 'json' };
}

export async function captureMqtt(options) {
  const repository = process.cwd(), scenePath = path.resolve(options.scene);
  const sceneBytes = await fs.readFile(scenePath), file = JSON.parse(sceneBytes.toString('utf8'));
  const config = file.scene?.mqttConfig;
  assert.equal(config?.address, ADVERTISED_BROKER, '只核验明确广告的同一地址；不猜新地址或端口');
  const broker = new URL(config.address); assert.ok(!broker.username && !broker.password, 'CONNECT必须匿名，不接受URL凭据');
  const subscriptions = config.subscriptions;
  assert.ok(Array.isArray(subscriptions) && subscriptions.length > 0, '场景没有实际订阅，不能猜测topic');
  assert.ok(subscriptions.every(value => typeof value.topic === 'string' && value.topic && [0, 1, 2].includes(value.qos)), '场景订阅格式不合法');
  assert.ok(Number.isInteger(options.seconds) && options.seconds >= 75 && options.seconds <= 300, '捕获时长必须为75–300秒');
  const taskRoot = path.resolve('output/phase2-completion-20261025');
  const output = path.resolve(options.output ?? path.join(taskRoot, 'mqtt-current-' + Date.now()));
  const relative = path.relative(taskRoot, output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '输出必须位于本任务根的新目录');
  await fs.mkdir(output);
  const startedAt = performance.now(), originUnixMs = Date.now();
  const require = createRequire(import.meta.url), mqtt = require('mqtt');
  const records = [], receipts = [], events = [], outgoingCommands = {};
  const report = { status: 'RUNNING', sourceKind: 'new-live-current-383-scene-receive-recording; NOT historical 1334-message recording',
    startedAt: new Date(originUnixMs).toISOString(), broker: broker.href, anonymous: true, publishCalls: 0,
    source: { scenePath, sceneSha256: sha(sceneBytes), sceneVersion: file.version, entityCount: file.scene.entityIds.length,
      subscriptions: subscriptions.map(value => ({ topic: value.topic, qos: value.qos, adapter: value.adapter ?? null })),
      scriptSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), node: process.version, mqtt: require('mqtt/package.json').version,
      protocolVersion: 4, brokerSoftwareVersion: null },
    policy: { connectTimeoutMs: CONNECT_TIMEOUT_MS, reconnectPeriod: 0, cleanSession: true, requestedSeconds: options.seconds,
      subscribeTimeoutMs: CONNECT_TIMEOUT_MS, maxRecords: MAX_RECORDS, maxPayloadBytes: MAX_PAYLOAD_BYTES, publicationProhibited: true },
    connected: false, subscriptionsGranted: [], recordsReceived: 0, sensitiveSkipped: 0, budgetSkipped: 0, formatFailures: 0,
    retainedRecords: 0, payloadBytes: 0, captureDurationMs: 0, events, receipts, outgoingCommands, cleanup: {} };
  const reportPath = path.join(output, 'report.json');
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  const event = (kind, detail = {}) => { events.push({ kind, atMs: performance.now() - startedAt, ...detail }); };
  let client, phase = 'connect', stopCapture, closeObserved = false, disconnecting = false, checkpoint;
  let captureStartedAt = null, subscriptionRequestedAt = null, captureEndedAt = null;
  const onStop = () => stopCapture?.('user-signal');
  process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
  try {
    event('connect-start'); await save();
    client = mqtt.connect(broker.href, { protocolVersion: 4, clientId: 'p2ro_' + randomBytes(7).toString('hex'),
      connectTimeout: CONNECT_TIMEOUT_MS, reconnectPeriod: 0, reconnectOnConnackError: false, clean: true,
      keepalive: 20, queueQoSZero: false, resubscribe: false, will: undefined,
      wsOptions: { handshakeTimeout: CONNECT_TIMEOUT_MS } });
    // 从API层禁止PUBLISH；本工具也不设置will，只允许标准连接/订阅/心跳/断开包。
    client.publish = () => { report.publishCalls++; throw new Error('只读捕获禁止PUBLISH'); };
    client.publishAsync = async () => { report.publishCalls++; throw new Error('只读捕获禁止PUBLISH'); };
    client.on('packetsend', packet => { outgoingCommands[packet.cmd] = (outgoingCommands[packet.cmd] ?? 0) + 1; });
    client.on('error', error => {
      receipts.push({ kind: 'mqtt-error', phase, atMs: performance.now() - startedAt, code: error.code ?? null,
        message: inlineSensitive.test(error.message) ? '[redacted error]' : error.message, returnCode: error.returnCode ?? null });
      if (phase === 'capture') stopCapture?.('mqtt-error');
    });
    client.on('close', () => { closeObserved = true; event('transport-close', { phase }); if (!disconnecting) stopCapture?.('connection-closed'); });
    client.on('message', (topic, payload, packet) => {
      const atMs = performance.now() - startedAt, sequence = report.recordsReceived++;
      const sensitiveTopic = inlineSensitive.test(topic), inspected = sensitiveTopic ? { sensitive: true, reason: 'sensitive-topic' } : inspectPayload(payload);
      const row = { sequence, atMs, receivedAtUnixMs: Date.now(), topic: sensitiveTopic ? '[sensitive-topic]' : topic,
        qos: packet.qos, retain: packet.retain, dup: packet.dup, messageId: packet.messageId ?? null, byteLength: payload.length };
      if (packet.retain) report.retainedRecords++;
      if (inspected.sensitive) {
        report.sensitiveSkipped++; Object.assign(row, { payloadRedacted: true, failureReceipt: inspected.reason });
      } else if (sequence >= MAX_RECORDS || report.payloadBytes + payload.length > MAX_PAYLOAD_BYTES) {
        report.budgetSkipped++; Object.assign(row, { payloadRedacted: true, failureReceipt: 'capture-budget-exceeded' });
        stopCapture?.('capture-budget-exceeded');
      } else {
        report.payloadBytes += payload.length;
        Object.assign(row, { payloadText: inspected.text, payloadBase64: payload.toString('base64'), payloadSha256: sha(payload),
          payloadTextByteExact: typeof inspected.text === 'string' && Buffer.from(inspected.text, 'utf8').equals(payload), format: inspected.format });
        if (inspected.format !== 'json') { report.formatFailures++; row.failureReceipt = inspected.format; }
      }
      records.push(row);
    });
    await new Promise((resolve, reject) => {
      const connected = packet => { cleanup(); report.connected = true; event('connect-accepted', { sessionPresent: Boolean(packet.sessionPresent), returnCode: packet.returnCode ?? 0 }); resolve(); };
      const failed = error => { cleanup(); reject(error); };
      const closed = () => { cleanup(); reject(new Error('Connection closed before CONNACK')); };
      const cleanup = () => { client.off('connect', connected); client.off('error', failed); client.off('close', closed); };
      client.once('connect', connected); client.once('error', failed); client.once('close', closed);
    });
    phase = 'subscribe'; subscriptionRequestedAt = performance.now(); event('subscribe-start');
    for (const subscription of subscriptions) {
      const granted = await withDeadline(client.subscribeAsync(subscription.topic, { qos: subscription.qos }), CONNECT_TIMEOUT_MS, 'SUBACK timeout');
      report.subscriptionsGranted.push(...granted);
      assert.ok(granted.length && granted.every(value => value.qos >= 0 && value.qos <= 2), 'SUBACK拒绝订阅');
    }
    phase = 'capture'; captureStartedAt = performance.now(); event('capture-start'); await save();
    checkpoint = setInterval(() => { void save().catch(() => {}); console.log(JSON.stringify({ phase, received: report.recordsReceived, sensitiveSkipped: report.sensitiveSkipped })); }, 15000);
    const stopReason = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('duration-completed'), options.seconds * 1000);
      stopCapture = reason => { clearTimeout(timer); resolve(reason); };
    });
    captureEndedAt = performance.now(); report.captureDurationMs = captureEndedAt - captureStartedAt; report.stopReason = stopReason;
    report.captureComplete = stopReason === 'duration-completed' && report.captureDurationMs >= options.seconds * 1000 - 5;
    report.status = report.captureComplete ? 'CAPTURED' : 'INCOMPLETE';
  } catch (error) {
    report.status = phase === 'connect' ? 'CONNECT_FAILED' : phase === 'subscribe' ? 'SUBSCRIBE_FAILED' : 'INCOMPLETE';
    report.error = { phase, name: error.name, code: error.code ?? null, message: inlineSensitive.test(error.message) ? '[redacted error]' : error.message };
  } finally {
    clearInterval(checkpoint); disconnecting = true; phase = 'cleanup';
    event('disconnect-start');
    if (client) {
      let endTimer;
      try {
        await Promise.race([client.endAsync(!client.connected), new Promise((_, reject) => { endTimer = setTimeout(() => reject(new Error('disconnect timeout')), 3000); })]);
        report.cleanup.endCompleted = true;
      } catch (error) { client.stream?.destroy(); report.cleanup.forcedTransportDestroy = true; report.cleanup.error = error.message; }
      finally { clearTimeout(endTimer); }
      report.cleanup.transportDestroyed = Boolean(client.stream?.destroyed); report.cleanup.disconnected = !client.connected;
    }
    event('disconnect-finished'); report.cleanup.closeEventObserved = closeObserved;
    process.off('SIGINT', onStop); process.off('SIGTERM', onStop);
    report.sourceUnchanged = sha(await fs.readFile(scenePath)) === report.source.sceneSha256;
    report.endedAt = new Date().toISOString();
    const live = records.filter(row => !row.retain && !row.payloadRedacted), gaps = live.slice(1).map((row, index) => row.atMs - live[index].atMs);
    report.summary = { sensitiveSkipped: report.sensitiveSkipped, budgetSkipped: report.budgetSkipped,
      liveRecords: live.length, retainedRecords: report.retainedRecords, captureDurationMs: report.captureDurationMs,
      liveSpanMs: live.length > 1 ? live.at(-1).atMs - live[0].atMs : 0, maxLiveGapMs: gaps.length ? Math.max(...gaps) : null,
      allLocalMessageSlotsStored: records.length === report.recordsReceived,
      replayCompatible: records.length > 0 && records.every(row => typeof row.payloadText === 'string' && row.payloadTextByteExact && !row.payloadRedacted),
      lossless: false, losslessReason: 'Only local receive events are observable; original broker publication counts and QoS0 network loss are not verified.',
      formalMotionAcceptancePass: false };
    report.receiveOrigin = { originUnixMs, relativeTime: 'performance.now since connection attempt; source receive time, NOT source publication time',
      subscriptionRequestedAtMs: subscriptionRequestedAt === null ? null : subscriptionRequestedAt - startedAt,
      captureStartAtMs: captureStartedAt === null ? null : captureStartedAt - startedAt,
      captureEndAtMs: captureEndedAt === null ? null : captureEndedAt - startedAt };
    await fs.writeFile(path.join(output, 'records.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + (records.length ? '\n' : ''), { flag: 'wx' });
    const recording = { source: report.source, broker: report.broker, receiveOrigin: report.receiveOrigin, summary: report.summary, records };
    await fs.writeFile(path.join(output, 'recording.json'), JSON.stringify(recording, null, 2), { flag: 'wx' });
    report.recordingSha256 = sha(await fs.readFile(path.join(output, 'recording.json')));
    assert.equal(report.publishCalls, 0); assert.equal(outgoingCommands.publish ?? 0, 0);
    await save();
    console.log(JSON.stringify({ status: report.status, reportPath, received: report.recordsReceived, sensitiveSkipped: report.sensitiveSkipped, cleanup: report.cleanup }));
  }
  return report;
}

async function withDeadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { scene: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string', default: '75' }, help: { type: 'boolean', default: false } } });
  if (values.help) console.log('node scripts/phase2-mqtt-capture.mjs --scene <actual.scene.json> [--output <new task directory>] [--seconds 75]');
  else {
    assert.ok(values.scene, '--scene必需');
    const report = await captureMqtt({ scene: values.scene, output: values.output, seconds: Number(values.seconds) });
    if (report.status !== 'CAPTURED' || !report.summary.replayCompatible) process.exitCode = 1;
  }
}
