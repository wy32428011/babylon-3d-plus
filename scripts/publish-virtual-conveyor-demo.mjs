import process from 'node:process';
import mqtt from 'mqtt';

const DEFAULT_BROKER = 'ws://127.0.0.1:8083/mqtt';
const DEFAULT_INTERVAL_MS = 500;
const DEVICE_TYPE = 'conveyor';
const TOPIC_SUFFIX = 'twindatadriven/joint';
const DEFAULT_CONVEYOR_A = 'VirtualConveyor-A';
const DEFAULT_CONVEYOR_B = 'VirtualConveyor-B';

/** 单条输送线的演示动作段；数值字段与 conveyorDriver MQTT 消费一一对应。 */
function conveyorFrame({ task, mode, movement, frontHasGoods, backHasGoods = false, containerCode = '' }) {
  return { task, mode, movement, frontHasGoods, backHasGoods, containerCode };
}

/** 空闲帧：task/mode/movement 全 0，双光电无货。 */
function idleFrame() {
  return conveyorFrame({ task: 0, mode: 0, movement: 0, frontHasGoods: false });
}

/** 把演示时间线展开成固定动作段：刷货 → A 输送 → 越界交接给 B → B 输送 → B 末端销货 → 复位。 */
function createTimeline(taskId, containerCode) {
  return [
    {
      name: `起点刷货起步（task=${taskId}）`,
      durationMs: 4000,
      a: conveyorFrame({ task: taskId, mode: 1, movement: 1, frontHasGoods: true, containerCode }),
      b: conveyorFrame({ task: taskId, mode: 1, movement: 1, frontHasGoods: false }),
    },
    {
      name: 'A 货物输送中',
      durationMs: 5000,
      a: conveyorFrame({ task: taskId, mode: 1, movement: 1, frontHasGoods: true, containerCode }),
      b: conveyorFrame({ task: taskId, mode: 1, movement: 1, frontHasGoods: false }),
    },
    {
      name: '越界交接 → B 接管输送',
      durationMs: 9000,
      a: conveyorFrame({ task: taskId, mode: 1, movement: 0, frontHasGoods: false }),
      b: conveyorFrame({ task: taskId, mode: 1, movement: 1, frontHasGoods: true, containerCode }),
    },
    {
      name: 'B 末端销货（mode=2 双光电无货）',
      durationMs: 3000,
      a: idleFrame(),
      b: conveyorFrame({ task: taskId, mode: 2, movement: 0, frontHasGoods: false }),
    },
    {
      name: '复位空闲',
      durationMs: 2000,
      a: idleFrame(),
      b: idleFrame(),
    },
  ];
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = {
    broker: DEFAULT_BROKER,
    username: '',
    password: '',
    assetA: DEFAULT_CONVEYOR_A,
    assetB: DEFAULT_CONVEYOR_B,
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
    else if (arg === '--asset-a' && next) options.assetA = next, index += 1;
    else if (arg === '--asset-b' && next) options.assetB = next, index += 1;
    else if (arg === '--interval-ms' && next) options.intervalMs = Math.max(50, Number(next) || DEFAULT_INTERVAL_MS), index += 1;
    else if (arg === '--speed' && next) options.speed = Math.max(0.1, Number(next) || 1), index += 1;
    else if (arg === '--loops' && next) options.loops = Math.max(1, Math.trunc(Number(next) || 1)), index += 1;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--retain') options.retain = true;
    else if (arg === '--help' || arg === '-h') printHelpAndExit();
  }
  return options;
}

function printHelpAndExit() {
  console.log(`虚拟输送线 MQTT 交接演示

用法：
  npm run demo:conveyor:mqtt
  node scripts/publish-virtual-conveyor-demo.mjs --asset-a VirtualConveyor-A --asset-b VirtualConveyor-B
  node scripts/publish-virtual-conveyor-demo.mjs --stdout --speed 2

流程：
  A（起点设备，cargoOriginDevice）刷货 → movement_x=1 正向输送 → 出口探测邻居 B，
  B 订阅同 task 越界交接 → B 继续输送 → B 末端 mode=2 + 双光电无货销货 → 复位。
  每轮 task 号递增（1,2,3...），货箱号随之更新。

参数：
  --broker <url>       MQTT over WebSocket 地址，默认 ${DEFAULT_BROKER}
  --username <name>    MQTT 用户名
  --password <value>   MQTT 密码
  --asset-a <code>     起点输送线资产编号，默认 ${DEFAULT_CONVEYOR_A}
  --asset-b <code>     下游输送线资产编号，默认 ${DEFAULT_CONVEYOR_B}
  --interval-ms <ms>   发布间隔，默认 ${DEFAULT_INTERVAL_MS}ms
  --speed <ratio>      时间加速倍率
  --loops <count>      流程循环次数
  --stdout             不连接 Broker，只打印消息
  --retain             使用 retain=true 发布
`);
  process.exit(0);
}

/** 创建 EPV 点位。 */
function point(assetCode, p, v) {
  return { e: assetCode, p, v };
}

/** 生成单台输送线的 MQTT 负载。 */
function createPayload(assetCode, frame, message) {
  return {
    data: [
      point(assetCode, 'deviceCode', assetCode),
      point(assetCode, 'task', frame.task),
      point(assetCode, 'mode', frame.mode),
      point(assetCode, 'movement_x', frame.movement),
      point(assetCode, 'front_has_goods', frame.frontHasGoods),
      point(assetCode, 'back_has_goods', frame.backHasGoods),
      point(assetCode, 'containerCode', frame.containerCode),
      point(assetCode, 'normal', true),
      point(assetCode, 'errorCode', 0),
      point(assetCode, 'message', message),
    ],
    ts: new Date().toISOString(),
  };
}

function createTopic(assetCode) {
  return `dt/factory/logistics/${DEVICE_TYPE}/${assetCode}/${TOPIC_SUFFIX}`;
}

/** 查找当前动作段。 */
function resolveFrame(timeline, elapsedMs) {
  let cursor = 0;
  for (const item of timeline) {
    const end = cursor + item.durationMs;
    if (elapsedMs < end) return item;
    cursor = end;
  }
  return timeline.at(-1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectMqtt(broker, username, password) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(broker, {
      clean: true,
      clientId: `virtual-conveyor-demo-${process.pid}`,
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

function publish(client, topic, payload, retain) {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 0, retain }, (error) => error ? reject(error) : resolve());
  });
}

function closeClient(client) {
  if (!client.connected) return Promise.resolve();
  return new Promise((resolve) => client.end(false, resolve));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const timelines = Array.from({ length: options.loops }, (_, index) =>
    createTimeline(index + 1, `VC-${String(index + 1).padStart(4, '0')}`),
  );
  const cycleMs = timelines[0].reduce((sum, item) => sum + item.durationMs, 0);
  const totalRealMs = cycleMs * options.loops / options.speed;
  const topicA = createTopic(options.assetA);
  const topicB = createTopic(options.assetB);
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

  console.log(`起点输送线：${options.assetA}（${topicA}）`);
  console.log(`下游输送线：${options.assetB}（${topicB}）`);
  console.log(`预计耗时：${Math.ceil(totalRealMs / 1000)} 秒，速度 ${options.speed}x，循环 ${options.loops} 次`);

  try {
    while (!options.interrupted && Date.now() - startedAt <= totalRealMs) {
      const virtualElapsed = (Date.now() - startedAt) * options.speed;
      const loopIndex = Math.min(options.loops - 1, Math.floor(virtualElapsed / cycleMs));
      const frame = resolveFrame(timelines[loopIndex], virtualElapsed - loopIndex * cycleMs);
      if (frame.name !== lastStepName) {
        console.log(`[动作] ${frame.name}`);
        lastStepName = frame.name;
      }
      const payloadA = createPayload(options.assetA, frame.a, frame.name);
      const payloadB = createPayload(options.assetB, frame.b, frame.name);
      if (client) {
        await publish(client, topicA, payloadA, options.retain);
        await publish(client, topicB, payloadB, options.retain);
      } else {
        console.log(`${topicA} ${JSON.stringify(payloadA)}`);
        console.log(`${topicB} ${JSON.stringify(payloadB)}`);
      }
      tick += 1;
      await delay(options.intervalMs);
    }
    console.log(`${options.interrupted ? '虚拟输送线演示已中断' : '虚拟输送线演示发送完成'}，共 ${tick} 轮消息。`);
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    if (client) await closeClient(client);
  }
}

run().catch((error) => {
  console.error(`虚拟输送线演示发送失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
