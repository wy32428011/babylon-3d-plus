import mqtt from 'mqtt';

const DEFAULT_BROKER = 'ws://127.0.0.1:8083/mqtt';
const DEFAULT_DEVICE_TYPE = 'agv';
const DEFAULT_SPAWNER_CODE = 'AGV-SPAWN';
const DEFAULT_DEVICE_COUNT = 3;
const DEFAULT_INTERVAL_MS = 500;
const TOPIC_SEGMENT = 'dataspawn';

/** 解析命令行参数，保持脚本无额外依赖。 */
function parseArgs(argv) {
  const options = {
    broker: DEFAULT_BROKER,
    deviceType: DEFAULT_DEVICE_TYPE,
    spawner: DEFAULT_SPAWNER_CODE,
    count: DEFAULT_DEVICE_COUNT,
    topic: '',
    intervalMs: DEFAULT_INTERVAL_MS,
    offlineProbability: 0.02,
    once: false,
    stdout: false,
    retain: false,
    durationMs: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--broker' && next) options.broker = next, index += 1;
    else if (arg === '--device-type' && next) options.deviceType = next, index += 1;
    else if (arg === '--spawner' && next) options.spawner = next, index += 1;
    else if (arg === '--count' && next) options.count = Math.max(1, Number(next) || DEFAULT_DEVICE_COUNT), index += 1;
    else if (arg === '--topic' && next) options.topic = next, index += 1;
    else if (arg === '--interval-ms' && next) options.intervalMs = Math.max(100, Number(next) || DEFAULT_INTERVAL_MS), index += 1;
    else if (arg === '--duration-ms' && next) options.durationMs = Math.max(0, Number(next) || 0), index += 1;
    else if (arg === '--offline-probability' && next) options.offlineProbability = Math.min(1, Math.max(0, Number(next) || 0)), index += 1;
    else if (arg === '--once') options.once = true;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--retain') options.retain = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  options.topic ||= `dt/factory/logistics/${options.deviceType}/${options.spawner}/${TOPIC_SEGMENT}/joint`;
  return options;
}

/** 输出脚本用法，便于现场调试不同 broker 和产生器 id。 */
function printHelp() {
  console.log(`设备产生器 MQTT 模拟器

用法：
  npm run demo:spawn:mqtt
  node scripts/simulate-device-spawn-mqtt.mjs --broker ws://127.0.0.1:8083/mqtt --spawner AGV-SPAWN --count 3
  node scripts/simulate-device-spawn-mqtt.mjs --once --stdout

参数：
  --broker <url>             MQTT over WebSocket 地址，默认 ${DEFAULT_BROKER}
  --device-type <type>       设备类型，默认 ${DEFAULT_DEVICE_TYPE}
  --spawner <code>           产生器 id，默认 ${DEFAULT_SPAWNER_CODE}（需与场景中设备产生器组件一致）
  --count <n>                模拟设备数量，默认 ${DEFAULT_DEVICE_COUNT}
  --topic <topic>            完整 topic，默认按设备类型和产生器 id 生成
  --interval-ms <ms>         发布间隔，默认 ${DEFAULT_INTERVAL_MS}
  --offline-probability <p>  每帧每台设备随机下线概率 0~1，默认 0.02
  --duration-ms <ms>         持续时间，0 表示一直运行
  --once                     只发布或打印一条
  --stdout                   不连接 broker，只打印 payload
  --retain                   以 retain=true 发布
`);
}

/** 创建 payload.data 中的单个点位，s 为产生器 id。 */
function point(assetCode, spawnerCode, p, v) {
  return { e: assetCode, p, v, s: spawnerCode };
}

/** 生成一条符合 dataspawn/joint 协议的消息：每台在线设备一组运动点位，随机下线设备发 status/offline。 */
function createSpawnPayload(options, pool, tick) {
  const seconds = tick * (options.intervalMs / 1000);
  const data = [];

  for (const device of pool) {
    if (device.online && options.offlineProbability > 0 && Math.random() < options.offlineProbability) {
      device.online = false;
      data.push(point(device.assetCode, options.spawner, 'status', 'offline'));
      continue;
    }
    if (!device.online) {
      device.online = true;
    }

    const wave = Math.sin(seconds * 0.6 + device.phase);
    data.push(
      point(device.assetCode, options.spawner, 'deviceCode', device.assetCode),
      point(device.assetCode, options.spawner, 'movement_x', wave >= 0 ? 1 : 2),
      point(device.assetCode, options.spawner, 'distance_x', Math.round((5 + wave * 3 + device.phase) * 10000) / 10000),
      point(device.assetCode, options.spawner, 'normal', true),
      point(device.assetCode, options.spawner, 'errorCode', 0),
      point(device.assetCode, options.spawner, 'message', '模拟运行'),
    );
  }

  return { data, ts: new Date().toISOString() };
}

/** 创建稳定的模拟设备池，资产编号在脚本生命周期内不变。 */
function createDevicePool(options) {
  const pool = [];
  for (let index = 0; index < options.count; index += 1) {
    pool.push({
      assetCode: `${options.spawner}-${String(index + 1).padStart(2, '0')}`,
      online: true,
      phase: index * 0.7,
    });
  }
  return pool;
}

/** 打印或发布一条消息。 */
function emitPayload(client, options, pool, tick) {
  const payload = createSpawnPayload(options, pool, tick);
  const payloadText = JSON.stringify(payload);
  if (options.stdout) {
    console.log(`${options.topic} ${payloadText}`);
    return;
  }

  client.publish(options.topic, payloadText, { qos: 0, retain: options.retain });
  const offlineCount = payload.data.filter((item) => item.p === 'status').length;
  console.log(`已发布 #${tick} -> ${options.topic} 在线 ${pool.filter((d) => d.online).length}/${pool.length}${offlineCount ? `，下线 ${offlineCount}` : ''}`);
}

/** 启动 stdout 模式，不依赖 broker。 */
function runStdout(options) {
  const pool = createDevicePool(options);
  let tick = 0;
  emitPayload(null, options, pool, tick);
  if (options.once) return;

  const timer = setInterval(() => {
    tick += 1;
    emitPayload(null, options, pool, tick);
  }, options.intervalMs);
  stopAfterDuration(timer, options.durationMs);
}

/** 启动 MQTT 发布模式。 */
function runMqtt(options) {
  const client = mqtt.connect(options.broker, {
    clean: true,
    clientId: `device-spawn-simulator-${options.spawner}-${process.pid}`,
    connectTimeout: 8000,
    reconnectPeriod: 3000,
  });
  const pool = createDevicePool(options);
  let tick = 0;
  let timer = null;

  client.on('connect', () => {
    console.log(`MQTT 模拟器已连接：${options.broker}`);
    console.log(`发布 topic：${options.topic}`);
    emitPayload(client, options, pool, tick);
    if (options.once) {
      client.end(false, () => process.exit(0));
      return;
    }

    if (!timer) {
      timer = setInterval(() => {
        tick += 1;
        emitPayload(client, options, pool, tick);
      }, options.intervalMs);
      stopAfterDuration(timer, options.durationMs, () => client.end());
    }
  });

  client.on('error', (error) => {
    console.error(`MQTT 连接错误：${error.message}`);
  });

  process.on('SIGINT', () => {
    if (timer) clearInterval(timer);
    client.end(false, () => process.exit(0));
  });
}

/** 到达持续时间后停止定时器。 */
function stopAfterDuration(timer, durationMs, onStop = () => undefined) {
  if (!durationMs) return;
  setTimeout(() => {
    clearInterval(timer);
    onStop();
  }, durationMs);
}

const options = parseArgs(process.argv.slice(2));
if (options.stdout) runStdout(options);
else runMqtt(options);
