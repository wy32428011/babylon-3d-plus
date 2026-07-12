import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import mqtt from 'mqtt';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SEQUENCE_FILE = path.join(WORKSPACE_ROOT, 'examples', 'mqtt', 'stacker-full-demo-sequence.json');
const DEFAULT_BROKER = 'ws://127.0.0.1:8083/mqtt';
const DEFAULT_INTERVAL_MS = 250;

/** 解析命令行参数，支持覆盖 Broker、设备、库位任务、速度和循环次数。 */
function parseArgs(argv) {
  const options = {
    broker: DEFAULT_BROKER,
    sequenceFile: DEFAULT_SEQUENCE_FILE,
    username: '',
    password: '',
    asset: '',
    topic: '',
    locations: [],
    intervalMs: DEFAULT_INTERVAL_MS,
    speed: 1,
    loops: 1,
    stdout: false,
    retain: false,
    interrupted: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--broker' && next) options.broker = next, index += 1;
    else if (arg === '--username' && next) options.username = next, index += 1;
    else if (arg === '--password' && next) options.password = next, index += 1;
    else if (arg === '--sequence' && next) options.sequenceFile = path.resolve(next), index += 1;
    else if (arg === '--asset' && next) options.asset = next, index += 1;
    else if (arg === '--topic' && next) options.topic = next, index += 1;
    else if (arg === '--locations' && next) options.locations = next.split(',').map((value) => value.trim()).filter(Boolean), index += 1;
    else if (arg === '--interval-ms' && next) options.intervalMs = Math.max(50, Number(next) || DEFAULT_INTERVAL_MS), index += 1;
    else if (arg === '--speed' && next) options.speed = Math.max(0.1, Number(next) || 1), index += 1;
    else if (arg === '--loops' && next) options.loops = Math.max(1, Math.trunc(Number(next) || 1)), index += 1;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--retain') options.retain = true;
    else if (arg === '--help' || arg === '-h') printHelpAndExit();
  }
  return options;
}

/** 输出库位驱动 Demo 用法。 */
function printHelpAndExit() {
  console.log(`Stacker MQTT 库位驱动演示

用法：
  npm run demo:stacker:mqtt
  node scripts/publish-stacker-full-demo.mjs --locations 1-1-1,1-2-1
  node scripts/publish-stacker-full-demo.mjs --stdout --speed 20

规则：
  MQTT 发送目标库位号 to_x/to_y/to_z 和动作编码，不发送 distance_x/distance_y/front_distance_z/back_distance_z。
  场景虚拟定位框 storageDepth=near 时只用一段货叉，storageDepth=far 时使用两段货叉。

参数：
  --broker <url>       MQTT over WebSocket 地址，默认 ${DEFAULT_BROKER}
  --username <name>    MQTT 用户名
  --password <value>   MQTT 密码
  --sequence <file>    库位任务 JSON
  --asset <code>       覆盖设备资产编号
  --topic <topic>      覆盖完整发布 Topic
  --locations <ids>    仅执行指定库位，逗号分隔，例如 1-1-1,1-2-1
  --interval-ms <ms>   发布间隔，默认 ${DEFAULT_INTERVAL_MS}ms
  --speed <ratio>      时间加速倍率
  --loops <count>      任务列表循环次数
  --stdout             不连接 Broker，只打印消息
  --retain             使用 retain=true 发布
`);
  process.exit(0);
}

/** 读取并校验库位和任务配置。 */
async function loadSequence(filePath) {
  const text = await readFile(filePath, 'utf8');
  const sequence = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (sequence?.schema !== 'babylon-editor.stacker-location-demo' || sequence?.version !== 2) {
    throw new Error('库位任务 schema/version 不受支持');
  }
  if (!Array.isArray(sequence.locations) || sequence.locations.length === 0) throw new Error('locations 不能为空');
  if (!Array.isArray(sequence.tasks) || sequence.tasks.length === 0) throw new Error('tasks 不能为空');
  const locations = new Map();
  for (const [index, location] of sequence.locations.entries()) {
    validateLocation(location, index);
    if (locations.has(location.assetId)) throw new Error(`库位号重复：${location.assetId}`);
    locations.set(location.assetId, location);
  }
  for (const [index, task] of sequence.tasks.entries()) {
    if (!task || typeof task.locationAssetId !== 'string' || !locations.has(task.locationAssetId)) {
      throw new Error(`第 ${index + 1} 个任务引用了不存在的库位`);
    }
    if (task.side !== 'front' && task.side !== 'back') throw new Error(`第 ${index + 1} 个任务 side 必须是 front 或 back`);
  }
  validateTiming(sequence.timing);
  return { ...sequence, locationMap: locations };
}

/** 校验库位号、排列层和近排/远排参数的一致性。 */
function validateLocation(location, index) {
  if (!location || typeof location.assetId !== 'string' || !/^\d+-\d+-\d+$/.test(location.assetId)) {
    throw new Error(`第 ${index + 1} 个库位 assetId 必须是“排-列-层”格式`);
  }
  const parts = location.assetId.split('-').map(Number);
  if (parts[0] !== location.row || parts[1] !== location.column || parts[2] !== location.level) {
    throw new Error(`库位 ${location.assetId} 的 row/column/level 与资产编号不一致`);
  }
  if (location.storageDepth !== 'near' && location.storageDepth !== 'far') throw new Error(`库位 ${location.assetId} 缺少 near/far`);
  if (!Number.isFinite(location.distance_x) || !Number.isFinite(location.distance_y)) throw new Error(`库位 ${location.assetId} 缺少有效距离`);
}

/** 校验动作时长。 */
function validateTiming(timing) {
  for (const key of ['travelMs', 'travelHoldMs', 'liftMs', 'liftHoldMs', 'forkExtendMs', 'forkHoldMs', 'forkRetractMs', 'taskCompleteHoldMs', 'returnHomeMs']) {
    if (!Number.isFinite(timing?.[key]) || timing[key] <= 0) throw new Error(`timing.${key} 必须是正数`);
  }
}

/** 只保留用户指定的库位任务。 */
function selectTasks(sequence, selectedLocations) {
  if (selectedLocations.length === 0) return sequence.tasks;
  for (const assetId of selectedLocations) {
    if (!sequence.locationMap.has(assetId)) throw new Error(`未找到指定库位：${assetId}`);
  }
  return selectedLocations.map((assetId) => ({ locationAssetId: assetId, side: 'front' }));
}

/** 根据库位资产编号生成 to_x/to_y/to_z。 */
function parseLocationAssetId(assetId) {
  const [x, y, z] = assetId.split('-').map(Number);
  return { x, y, z };
}

/** 在起止位置间插值。 */
function interpolate(from, to, progress) {
  const normalized = Math.max(0, Math.min(1, progress));
  return from + (to - from) * normalized;
}

/** 把任务展开成可逐帧采样的动作段；货叉段不包含编码器距离。 */
function createTimeline(sequence, tasks) {
  const timeline = [];
  const home = { distanceX: sequence.home.distance_x, distanceY: sequence.home.distance_y };
  let current = { ...home };
  for (const task of tasks) {
    const location = sequence.locationMap.get(task.locationAssetId);
    const target = { distanceX: location.distance_x, distanceY: location.distance_y };
    const prefix = `${location.storageDepth === 'far' ? '远排' : '近排'}库位 ${location.assetId}`;
    timeline.push(
      step(`${prefix}：Stacker 行走`, sequence.timing.travelMs, current, { ...current, distanceX: target.distanceX }, location, task),
      step(`${prefix}：行走到位`, sequence.timing.travelHoldMs, { ...current, distanceX: target.distanceX }, { ...current, distanceX: target.distanceX }, location, task),
      step(`${prefix}：载货台升降`, sequence.timing.liftMs, { ...current, distanceX: target.distanceX }, target, location, task),
      step(`${prefix}：载货台到位`, sequence.timing.liftHoldMs, target, target, location, task),
      step(`${prefix}：${location.storageDepth === 'far' ? '二段货叉' : '一段货叉'}叉出`, sequence.timing.forkExtendMs, target, target, location, task, 'extend'),
      step(`${prefix}：货叉保持`, sequence.timing.forkHoldMs, target, target, location, task, 'hold'),
      step(`${prefix}：货叉收回`, sequence.timing.forkRetractMs, target, target, location, task, 'retract'),
      step(`${prefix}：任务完成`, sequence.timing.taskCompleteHoldMs, target, target, location, task),
    );
    current = target;
  }
  timeline.push(step('Stacker 返回原点', sequence.timing.returnHomeMs, current, home, null, { side: 'front' }));
  return timeline;
}

/** 创建单个动作段。 */
function step(name, durationMs, from, to, location, task, forkAction = 'idle') {
  return { name, durationMs, from, to, location, side: task.side, forkAction };
}

/** 查找当前动作段。 */
function resolveFrame(timeline, elapsedMs) {
  let cursor = 0;
  for (const item of timeline) {
    const end = cursor + item.durationMs;
    if (elapsedMs < end) {
      const progress = (elapsedMs - cursor) / item.durationMs;
      return {
        step: item,
        distanceX: interpolate(item.from.distanceX, item.to.distanceX, progress),
        distanceY: interpolate(item.from.distanceY, item.to.distanceY, progress),
      };
    }
    cursor = end;
  }
  const last = timeline.at(-1);
  return { step: last, distanceX: last.to.distanceX, distanceY: last.to.distanceY };
}

/** 创建 EPV 点位。 */
function point(assetCode, p, v) {
  return { e: assetCode, p, v };
}

/** 构造实际 Topic，只替换 /stacker/<assetCode>/ 段。 */
function createDefaultTopic(sequence, assetCode) {
  const segments = String(sequence.topic).split('/');
  const index = segments.findIndex((segment, currentIndex) => segment === sequence.assetCode && segments[currentIndex - 1] === 'stacker');
  if (index < 0) throw new Error('topic 必须包含 /stacker/<assetCode>/ 段');
  segments[index] = assetCode;
  return segments.join('/');
}

/** 生成库位任务 MQTT 消息，货叉距离由场景 Locator 决定。 */
function createPayload(assetCode, frame, tick, loopIndex) {
  const location = frame.step.location;
  const target = location ? parseLocationAssetId(location.assetId) : { x: 0, y: 0, z: 0 };
  const isFront = frame.step.side === 'front';
  const extendCode = isFront ? 1 : 3;
  const retractCode = isFront ? 2 : 4;
  const movementZ = frame.step.forkAction === 'extend' ? extendCode : frame.step.forkAction === 'retract' ? retractCode : 0;
  const isTraveling = Math.abs(frame.step.to.distanceX - frame.step.from.distanceX) > 0.0001;
  const isLifting = Math.abs(frame.step.to.distanceY - frame.step.from.distanceY) > 0.0001;
  const points = [
    point(assetCode, 'deviceCode', assetCode),
    point(assetCode, 'mode', 3),
    point(assetCode, 'front_command', isFront && frame.step.forkAction !== 'idle' ? 3 : 0),
    point(assetCode, 'back_command', !isFront && frame.step.forkAction !== 'idle' ? 3 : 0),
    point(assetCode, 'front_task', tick),
    point(assetCode, 'back_task', 0),
    point(assetCode, 'movement_x', isTraveling ? (frame.step.to.distanceX >= frame.step.from.distanceX ? 1 : 2) : 0),
    point(assetCode, 'movement_y', isLifting ? (frame.step.to.distanceY >= frame.step.from.distanceY ? 1 : 2) : 0),
    point(assetCode, 'front_movement_z', isFront ? movementZ : 0),
    point(assetCode, 'back_movement_z', isFront ? 0 : movementZ),
    point(assetCode, 'rpm_x', isTraveling ? 45 : 0),
    point(assetCode, 'rpm_y', isLifting ? 18 : 0),
    point(assetCode, 'front_rpm_z', isFront && movementZ ? 12 : 0),
    point(assetCode, 'back_rpm_z', !isFront && movementZ ? 12 : 0),
    point(assetCode, 'front_containerCode', ''),
    point(assetCode, 'back_containerCode', ''),
    point(assetCode, 'normal', true),
    point(assetCode, 'errorCode', 0),
    point(assetCode, 'message', `${frame.step.name}（第 ${loopIndex + 1} 轮）`),
    point(assetCode, 'to_x', target.x),
    point(assetCode, 'to_y', target.y),
    point(assetCode, 'to_z', target.z),
  ];
  return { data: points, ts: new Date().toISOString() };
}

/** 保留四位小数。 */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** 等待。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 建立 MQTT 连接。 */
function connectMqtt(broker, username, password) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(broker, {
      clean: true,
      clientId: `stacker-location-demo-${process.pid}`,
      connectTimeout: 8000,
      reconnectPeriod: 0,
      ...(username ? { username, password } : {}),
    });
    const onError = (error) => {
      client.end(true);
      reject(error);
    };
    client.once('error', onError);
    client.once('connect', () => {
      client.off('error', onError);
      resolve(client);
    });
  });
}

/** 发布一条消息。 */
function publish(client, topic, payload, retain) {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 0, retain }, (error) => error ? reject(error) : resolve());
  });
}

/** 关闭 MQTT。 */
function closeClient(client) {
  if (!client.connected) return Promise.resolve();
  return new Promise((resolve) => client.end(false, resolve));
}

/** 执行完整库位任务。 */
async function run() {
  const options = parseArgs(process.argv.slice(2));
  const sequence = await loadSequence(options.sequenceFile);
  const tasks = selectTasks(sequence, options.locations);
  const timeline = createTimeline(sequence, tasks);
  const assetCode = options.asset || sequence.assetCode;
  const topic = options.topic || createDefaultTopic(sequence, assetCode);
  const cycleMs = timeline.reduce((sum, item) => sum + item.durationMs, 0);
  const totalRealMs = cycleMs * options.loops / options.speed;
  const client = options.stdout ? null : await connectMqtt(options.broker, options.username, options.password);
  const onInterrupt = () => {
    options.interrupted = true;
    if (client?.connected) client.end(false);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const startedAt = Date.now();
  let tick = 0;
  let lastStepName = '';

  console.log(`库位任务：${tasks.map((task) => task.locationAssetId).join(' -> ')}`);
  console.log(`发布 topic：${topic}`);
  console.log(`预计耗时：${Math.ceil(totalRealMs / 1000)} 秒，速度 ${options.speed}x，循环 ${options.loops} 次`);

  try {
    while (!options.interrupted && Date.now() - startedAt <= totalRealMs) {
      const virtualElapsed = (Date.now() - startedAt) * options.speed;
      const loopIndex = Math.min(options.loops - 1, Math.floor(virtualElapsed / cycleMs));
      const frame = resolveFrame(timeline, Math.min(cycleMs, virtualElapsed - loopIndex * cycleMs));
      const payload = createPayload(assetCode, frame, tick, loopIndex);
      if (frame.step.name !== lastStepName) {
        console.log(`[动作] ${frame.step.name}`);
        lastStepName = frame.step.name;
      }
      if (client) await publish(client, topic, payload, options.retain);
      else console.log(`${topic} ${JSON.stringify(payload)}`);
      tick += 1;
      await delay(options.intervalMs);
    }
    console.log(`${options.interrupted ? '库位演示已中断' : '库位演示发送完成'}，共 ${tick} 条消息。`);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    if (client) await closeClient(client);
  }
}

run().catch((error) => {
  console.error(`库位演示发送失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
