import mqtt from 'mqtt';

const DEFAULT_BROKER = 'ws://127.0.0.1:8083/mqtt';
const DEFAULT_DEVICE_TYPE = 'agv';
const DEFAULT_SPAWNER_CODE = 'AGV-SPAWN';
const DEFAULT_DEVICE_COUNT = 3;
const DEFAULT_INTERVAL_MS = 500;

/** 解析命令行参数，保持脚本无额外依赖。 */
function parseArgs(argv) {
  const options = {
    broker: DEFAULT_BROKER,
    deviceType: DEFAULT_DEVICE_TYPE,
    spawner: DEFAULT_SPAWNER_CODE,
    count: DEFAULT_DEVICE_COUNT,
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

  return options;
}

/** 输出脚本用法，便于现场调试不同 broker 和产生器 id。 */
function printHelp() {
  console.log(`设备产生器 MQTT 模拟器

用法：
  npm run demo:spawn:mqtt
  node scripts/simulate-device-spawn-mqtt.mjs --broker ws://127.0.0.1:8083/mqtt --spawner AGV-SPAWN --count 3
  node scripts/simulate-device-spawn-mqtt.mjs --once --stdout

协议：
  topic 与常规设备一致：dt/factory/logistics/{deviceType}/{assetCode}/twindatadriven/joint（每台设备独立 topic）。
  每台设备上线首条消息点位携带 s（产生器 id）触发生成，后续保活不再携带；下线后发 p=status/v=offline。

参数：
  --broker <url>             MQTT over WebSocket 地址，默认 ${DEFAULT_BROKER}
  --device-type <type>       设备类型，默认 ${DEFAULT_DEVICE_TYPE}
  --spawner <code>           产生器 id，默认 ${DEFAULT_SPAWNER_CODE}（需与场景中设备产生器组件一致）
  --count <n>                模拟设备数量，默认 ${DEFAULT_DEVICE_COUNT}
  --interval-ms <ms>         发布间隔，默认 ${DEFAULT_INTERVAL_MS}
  --offline-probability <p>  每帧每台设备随机下线概率 0~1，默认 0.02
  --duration-ms <ms>         持续时间，0 表示一直运行
  --once                     只发布或打印一帧
  --stdout                   不连接 broker，只打印 payload
  --retain                   以 retain=true 发布
`);
}

/** 生成动态设备的常规遥测 topic（与真实设备一致，assetCode 为设备自身编号）。 */
function createDeviceTopic(options, assetCode) {
  return `dt/factory/logistics/${options.deviceType}/${assetCode}/twindatadriven/joint`;
}

/** 创建 payload.data 中的单个点位，withSpawner 时携带产生器 id。 */
function point(p, v, spawnerCode) {
  return spawnerCode ? { p, v, s: spawnerCode } : { p, v };
}

/**
 * 生成一台设备的本帧消息：下线帧返回 status/offline，上线首条携带 s，后续保活不带；无消息返回 null。
 */
function createDevicePayload(options, device, tick) {
  const seconds = tick * (options.intervalMs / 1000);

  if (device.online && options.offlineProbability > 0 && Math.random() < options.offlineProbability) {
    device.online = false;
    device.announced = false;
    return { data: [point('status', 'offline')], ts: new Date().toISOString() };
  }
  if (!device.online) {
    // 下线后停留一帧再上线，保证销毁可被观察到
    device.online = true;
  }

  const spawnerCode = device.announced ? null : options.spawner;
  device.announced = true;
  const wave = Math.sin(seconds * 0.6 + device.phase);
  return {
    data: [
      point('deviceCode', device.assetCode, spawnerCode),
      point('movement_x', wave >= 0 ? 1 : 2, spawnerCode),
      point('distance_x', Math.round((5 + wave * 3 + device.phase) * 10000) / 10000, spawnerCode),
      point('normal', true, spawnerCode),
      point('errorCode', 0, spawnerCode),
      point('message', '模拟运行', spawnerCode),
    ],
    ts: new Date().toISOString(),
  };
}

/** 创建稳定的模拟设备池，资产编号在脚本生命周期内不变。 */
function createDevicePool(options) {
  const pool = [];
  for (let index = 0; index < options.count; index += 1) {
    pool.push({
      assetCode: `${options.spawner}-${String(index + 1).padStart(2, '0')}`,
      online: true,
      announced: false,
      phase: index * 0.7,
    });
  }
  return pool;
}

/** 逐设备打印或发布一帧消息。 */
function emitFrame(client, options, pool, tick) {
  let offlineCount = 0;
  for (const device of pool) {
    const payload = createDevicePayload(options, device, tick);
    if (!payload) continue;
    const topic = createDeviceTopic(options, device.assetCode);
    const payloadText = JSON.stringify(payload);
    if (options.stdout) {
      console.log(`${topic} ${payloadText}`);
      continue;
    }
    client.publish(topic, payloadText, { qos: 0, retain: options.retain });
    if (payload.data.some((item) => item.p === 'status')) offlineCount += 1;
  }
  if (!options.stdout) {
    console.log(`已发布 #${tick} 在线 ${pool.filter((d) => d.online).length}/${pool.length}${offlineCount ? `，下线 ${offlineCount}` : ''}`);
  }
}

/** 启动 stdout 模式，不依赖 broker。 */
function runStdout(options) {
  const pool = createDevicePool(options);
  let tick = 0;
  emitFrame(null, options, pool, tick);
  if (options.once) return;

  const timer = setInterval(() => {
    tick += 1;
    emitFrame(null, options, pool, tick);
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
    console.log(`发布 topic：${createDeviceTopic(options, '<assetCode>')}（每台设备一段）`);
    emitFrame(client, options, pool, tick);
    if (options.once) {
      client.end(false, () => process.exit(0));
      return;
    }

    if (!timer) {
      timer = setInterval(() => {
        tick += 1;
        emitFrame(client, options, pool, tick);
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
