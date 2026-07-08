import mqtt from 'mqtt';

const DEFAULT_BROKER = 'ws://127.0.0.1:8083/mqtt';
const DEFAULT_ASSET_CODE = 'DDJ2';
const DEFAULT_DEVICE_TYPE = 'stacker';
const DEFAULT_INTERVAL_MS = 500;

/** 解析命令行参数，保持脚本无额外依赖。 */
function parseArgs(argv) {
  const options = {
    broker: DEFAULT_BROKER,
    asset: DEFAULT_ASSET_CODE,
    deviceType: DEFAULT_DEVICE_TYPE,
    topic: '',
    intervalMs: DEFAULT_INTERVAL_MS,
    scenario: 'cycle',
    once: false,
    stdout: false,
    retain: false,
    durationMs: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--broker' && next) options.broker = next, index += 1;
    else if (arg === '--asset' && next) options.asset = next, index += 1;
    else if (arg === '--device-type' && next) options.deviceType = next, index += 1;
    else if (arg === '--topic' && next) options.topic = next, index += 1;
    else if (arg === '--interval-ms' && next) options.intervalMs = Math.max(100, Number(next) || DEFAULT_INTERVAL_MS), index += 1;
    else if (arg === '--duration-ms' && next) options.durationMs = Math.max(0, Number(next) || 0), index += 1;
    else if (arg === '--scenario' && next) options.scenario = next, index += 1;
    else if (arg === '--once') options.once = true;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--retain') options.retain = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  options.topic ||= `dt/factory/logistics/${options.deviceType}/${options.asset}/twindatadriven/joint`;
  return options;
}

/** 输出脚本用法，便于现场调试不同 broker 和设备号。 */
function printHelp() {
  console.log(`Stacker MQTT 模拟器

用法：
  npm run demo:stacker:mqtt
  node scripts/simulate-stacker-mqtt.mjs --broker ws://127.0.0.1:8083/mqtt --asset DDJ2
  node scripts/simulate-stacker-mqtt.mjs --once --stdout

参数：
  --broker <url>       MQTT over WebSocket 地址，默认 ${DEFAULT_BROKER}
  --asset <code>       资产编号，默认 ${DEFAULT_ASSET_CODE}
  --device-type <type> 设备类型，默认 ${DEFAULT_DEVICE_TYPE}
  --topic <topic>      完整 topic，默认按设备类型和资产编号生成
  --scenario <name>    cycle | target | movement | fault，默认 cycle；conveyor 默认静止，movement 时运动
  --interval-ms <ms>   发布间隔，默认 ${DEFAULT_INTERVAL_MS}
  --duration-ms <ms>   持续时间，0 表示一直运行
  --once               只发布或打印一条
  --stdout             不连接 broker，只打印 payload
  --retain             以 retain=true 发布
`);
}

/** 创建 MQTT payload 中的 data[] 项。 */
function point(assetCode, p, v) {
  return { e: assetCode, p, v };
}

/** 按场景目标位生成确定性的运动轨迹。 */
function resolveMotionState(elapsedMs, scenario) {
  if (scenario === 'fault') {
    return {
      target: { x: 1, y: 1, z: 1 },
      distanceX: 2.8,
      distanceY: 0.6,
      frontDistanceZ: 0.1,
      backDistanceZ: 0,
      movementX: 0,
      movementY: 0,
      frontMovementZ: 0,
      backMovementZ: 0,
      frontCommand: 8,
      backCommand: 8,
      frontContainerCode: '',
      backContainerCode: '',
      normal: false,
      errorCode: 9001,
      message: '模拟急停',
    };
  }

  const seconds = elapsedMs / 1000;
  const targetSequence = [
    { x: 1, y: 1, z: 1, distanceX: 4, distanceY: 1.2 },
    { x: 2, y: 1, z: 1, distanceX: 7, distanceY: 1.2 },
    { x: 3, y: 2, z: 1, distanceX: 10, distanceY: 2.2 },
  ];
  const sequenceIndex = Math.floor(seconds / 8) % targetSequence.length;
  const phaseProgress = (seconds % 8) / 8;
  const activeTarget = targetSequence[sequenceIndex];
  const distanceWave = Math.sin(phaseProgress * Math.PI * 2);
  const distanceX = activeTarget.distanceX + distanceWave * 0.35;
  const distanceY = activeTarget.distanceY + Math.sin(phaseProgress * Math.PI * 4) * 0.12;
  const forkCycle = Math.floor(seconds / 2) % 4;

  if (scenario === 'movement' || (scenario === 'cycle' && Math.floor(seconds / 24) % 2 === 1)) {
    const direction = Math.floor(seconds / 6) % 2 === 0 ? 1 : 2;
    return {
      target: null,
      distanceX: 5 + Math.sin(seconds * 0.65) * 2.4,
      distanceY: 1.2 + Math.sin(seconds * 0.4) * 0.6,
      frontDistanceZ: Math.max(0, Math.sin(seconds * 0.9) * 0.7),
      backDistanceZ: Math.max(0, Math.cos(seconds * 0.8) * 0.5),
      movementX: direction,
      movementY: Math.sin(seconds * 0.4) >= 0 ? 1 : 2,
      frontMovementZ: [1, 2, 3, 4][forkCycle],
      backMovementZ: [3, 4, 1, 2][forkCycle],
      frontCommand: 1,
      backCommand: 3,
      frontContainerCode: 'PALLET-MOVE-F',
      backContainerCode: 'PALLET-MOVE-B',
      normal: true,
      errorCode: 0,
      message: '全 0 目标位，按 movement 模拟移动',
    };
  }

  const activeSide = sequenceIndex % 2 === 0 ? 'front' : 'back';
  const cargoCode = `PALLET-${String(sequenceIndex + 1).padStart(2, '0')}-${activeTarget.x}${activeTarget.y}${activeTarget.z}`;
  const forkDistance = resolveTargetForkDistance(phaseProgress);
  const frontActive = activeSide === 'front';

  return {
    target: activeTarget,
    distanceX,
    distanceY,
    frontDistanceZ: frontActive ? forkDistance : 0,
    backDistanceZ: frontActive ? 0 : forkDistance,
    movementX: Math.cos(phaseProgress * Math.PI * 2) >= 0 ? 1 : 2,
    movementY: Math.cos(phaseProgress * Math.PI * 4) >= 0 ? 1 : 2,
    frontMovementZ: frontActive ? resolveTargetForkMovement(phaseProgress, 1, 2) : 0,
    backMovementZ: frontActive ? 0 : resolveTargetForkMovement(phaseProgress, 3, 4),
    frontCommand: frontActive ? resolveTargetForkCommand(phaseProgress) : 0,
    backCommand: frontActive ? 0 : resolveTargetForkCommand(phaseProgress),
    frontContainerCode: frontActive ? resolveTargetContainerCode(cargoCode, phaseProgress) : '',
    backContainerCode: frontActive ? '' : resolveTargetContainerCode(cargoCode, phaseProgress),
    normal: true,
    errorCode: 0,
    message: `${frontActive ? '前叉' : '后叉'}放货到目标位 ${activeTarget.x}-${activeTarget.y}-${activeTarget.z}`,
  };
}

/** 目标位演示中生成货叉作业命令：取货、携带、放货、请求卸货、放货完成。 */
function resolveTargetForkCommand(phaseProgress) {
  if (phaseProgress < 0.18) return 1;
  if (phaseProgress < 0.52) return 2;
  if (phaseProgress < 0.8) return 3;
  if (phaseProgress < 0.92) return 4;
  return 5;
}

/** 目标位演示中生成货叉伸缩动作，前叉和后叉传入各自的伸出/缩回编码。 */
function resolveTargetForkMovement(phaseProgress, extendCode, retractCode) {
  if (phaseProgress >= 0.52 && phaseProgress < 0.8) return extendCode;
  if (phaseProgress >= 0.92 && phaseProgress < 0.98) return retractCode;
  return 0;
}

/** 目标位演示中生成货叉编码器距离，用于校准货物进入虚拟定位框的过程。 */
function resolveTargetForkDistance(phaseProgress) {
  if (phaseProgress < 0.52) return 0.12;
  if (phaseProgress < 0.8) return 0.12 + ((phaseProgress - 0.52) / 0.28) * 0.78;
  if (phaseProgress < 0.92) return 0.9;
  return Math.max(0.12, 0.9 - ((phaseProgress - 0.92) / 0.08) * 0.78);
}

/** 放货完成后清空叉上条码，验证运行时能让上一帧货物留在 locator 内。 */
function resolveTargetContainerCode(cargoCode, phaseProgress) {
  return phaseProgress >= 0.96 ? '' : cargoCode;
}

/** 按输送线协议生成静止、运动或故障状态。 */
function resolveConveyorState(elapsedMs, scenario) {
  if (scenario === 'fault') {
    return {
      mode: 4,
      task: 304,
      movementX: 0,
      movementY: 0,
      signalBits: 2,
      containerCode: '',
      normal: false,
      errorCode: 9101,
      message: '模拟输送线故障',
      layer: 0,
      rotation: 0,
      containerQuantity: 0,
      folding: 0,
      flip: 0,
      fork: 0,
      result: 0,
      result2: 0,
    };
  }

  if (scenario === 'movement') {
    const seconds = elapsedMs / 1000;
    const direction = Math.floor(seconds / 4) % 2 === 0 ? 1 : 2;
    return {
      mode: 2,
      task: 304 + Math.floor(seconds),
      movementX: direction,
      movementY: 0,
      signalBits: 2,
      containerCode: `BOX-${String(Math.floor(seconds / 4) + 1).padStart(3, '0')}`,
      normal: true,
      errorCode: 0,
      message: direction === 1 ? '模拟输送线正向运行' : '模拟输送线反向运行',
      layer: 0,
      rotation: 360,
      containerQuantity: 1,
      folding: 0,
      flip: 0,
      fork: 0,
      result: 0,
      result2: 0,
    };
  }

  return {
    mode: 2,
    task: 304,
    movementX: 0,
    movementY: 0,
    signalBits: 2,
    containerCode: '',
    normal: true,
    errorCode: 0,
    message: '正常',
    layer: 0,
    rotation: 0,
    containerQuantity: 0,
    folding: 0,
    flip: 0,
    fork: 0,
    result: 0,
    result2: 0,
  };
}

/** 生成一条符合 twindatadriven/joint 协议的 Stacker 消息。 */
function createStackerPayload(options, tick, startMs) {
  const elapsedMs = Date.now() - startMs;
  const motion = resolveMotionState(elapsedMs, options.scenario);
  const target = motion.target ?? { x: 0, y: 0, z: 0 };
  const frontLocation = motion.target ?? { x: 21, y: 7, z: 0 };

  return {
    data: [
      point(options.asset, 'deviceCode', '1'),
      point(options.asset, 'front_command', motion.frontCommand),
      point(options.asset, 'mode', motion.normal ? 3 : 4),
      point(options.asset, 'back_command', motion.backCommand),
      point(options.asset, 'front_z', frontLocation.z),
      point(options.asset, 'front_x', frontLocation.x),
      point(options.asset, 'front_y', frontLocation.y),
      point(options.asset, 'front_task', tick),
      point(options.asset, 'back_task', 0),
      point(options.asset, 'front_containerCode', motion.frontContainerCode),
      point(options.asset, 'back_containerCode', motion.backContainerCode),
      point(options.asset, 'signalBits', tick % 2),
      point(options.asset, 'front_signalBits', tick % 4),
      point(options.asset, 'back_signalBits', tick % 3),
      point(options.asset, 'movement_x', motion.movementX),
      point(options.asset, 'movement_y', motion.movementY),
      point(options.asset, 'front_movement_z', motion.frontMovementZ),
      point(options.asset, 'back_movement_z', motion.backMovementZ),
      point(options.asset, 'rpm_x', motion.movementX ? 45 : 0),
      point(options.asset, 'rpm_y', motion.movementY ? 18 : 0),
      point(options.asset, 'front_rpm_z', motion.frontMovementZ ? 12 : 0),
      point(options.asset, 'back_rpm_z', motion.backMovementZ ? 10 : 0),
      point(options.asset, 'distance_x', round(motion.distanceX)),
      point(options.asset, 'distance_y', round(motion.distanceY)),
      point(options.asset, 'front_distance_z', round(motion.frontDistanceZ)),
      point(options.asset, 'back_distance_z', round(motion.backDistanceZ)),
      point(options.asset, 'workingHours_x', round(elapsedMs / 3600000)),
      point(options.asset, 'workingHours_y', round(elapsedMs / 7200000)),
      point(options.asset, 'front_workingHours_z', round(elapsedMs / 9000000)),
      point(options.asset, 'back_workingHours_z', round(elapsedMs / 9000000)),
      point(options.asset, 'normal', motion.normal),
      point(options.asset, 'errorCode', motion.errorCode),
      point(options.asset, 'message', motion.message),
      point(options.asset, 'to_z', target.z),
      point(options.asset, 'to_x', target.x),
      point(options.asset, 'to_y', target.y),
    ],
    ts: new Date().toISOString(),
  };
}

/** 生成一条符合 twindatadriven/joint 协议的 Conveyor 消息。 */
function createConveyorPayload(options, tick, startMs) {
  const elapsedMs = Date.now() - startMs;
  const state = resolveConveyorState(elapsedMs, options.scenario);

  return {
    data: [
      point(options.asset, 'deviceCode', options.asset),
      point(options.asset, 'mode', state.mode),
      point(options.asset, 'task', state.task + tick),
      point(options.asset, 'movement_x', state.movementX),
      point(options.asset, 'movement_y', state.movementY),
      point(options.asset, 'signalBits', state.signalBits),
      point(options.asset, 'containerCode', state.containerCode),
      point(options.asset, 'workingHours_x', round(elapsedMs / 3600000)),
      point(options.asset, 'workingHours_y', round(elapsedMs / 7200000)),
      point(options.asset, 'normal', state.normal),
      point(options.asset, 'errorCode', state.errorCode),
      point(options.asset, 'message', state.message),
      point(options.asset, 'layer', state.layer),
      point(options.asset, 'rotation', state.rotation),
      point(options.asset, 'container_quantity', state.containerQuantity),
      point(options.asset, 'folding', state.folding),
      point(options.asset, 'flip', state.flip),
      point(options.asset, 'fork', state.fork),
      point(options.asset, 'result', state.result),
      point(options.asset, 'result2', state.result2),
    ],
    ts: new Date().toISOString(),
  };
}

/** 根据设备类型选择 payload 生成器。 */
function createTelemetryPayload(options, tick, startMs) {
  return options.deviceType.toLowerCase() === 'conveyor'
    ? createConveyorPayload(options, tick, startMs)
    : createStackerPayload(options, tick, startMs);
}

/** 将模拟数值收敛到 4 位小数，避免 payload 过长。 */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** 打印或发布一条消息。 */
function emitPayload(client, options, tick, startMs) {
  const payload = createTelemetryPayload(options, tick, startMs);
  const payloadText = JSON.stringify(payload);
  if (options.stdout) {
    console.log(`${options.topic} ${payloadText}`);
    return;
  }

  client.publish(options.topic, payloadText, { qos: 0, retain: options.retain });
  console.log(`已发布 #${tick} -> ${options.topic} ${payload.data.at(-3).v}`);
}

/** 启动 stdout 模式，不依赖 broker。 */
function runStdout(options) {
  const startMs = Date.now();
  let tick = 0;
  emitPayload(null, options, tick, startMs);
  if (options.once) return;

  const timer = setInterval(() => {
    tick += 1;
    emitPayload(null, options, tick, startMs);
  }, options.intervalMs);
  stopAfterDuration(timer, options.durationMs);
}

/** 启动 MQTT 发布模式。 */
function runMqtt(options) {
  const client = mqtt.connect(options.broker, {
    clean: true,
    clientId: `telemetry-simulator-${options.deviceType}-${options.asset}-${process.pid}`,
    connectTimeout: 8000,
    reconnectPeriod: 3000,
  });
  const startMs = Date.now();
  let tick = 0;
  let timer = null;

  client.on('connect', () => {
    console.log(`MQTT 模拟器已连接：${options.broker}`);
    console.log(`发布 topic：${options.topic}`);
    emitPayload(client, options, tick, startMs);
    if (options.once) {
      client.end(false, () => process.exit(0));
      return;
    }

    if (!timer) {
      timer = setInterval(() => {
        tick += 1;
        emitPayload(client, options, tick, startMs);
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
