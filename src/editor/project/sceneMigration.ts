type PlainObject = Record<string, unknown>;

type LegacyGeneratorBinding = {
  id: string;
  sourceId: string;
  deviceType: string;
  assetCode: string;
};

type MigrationSummary = {
  migratedCargoGenerators: number;
  migratedUpstreams: number;
  warnings: string[];
};

/** 读取字符串字段，非字符串按空串处理。 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** 解析设备实体的资产编号：优先显式遥测绑定，回退模型资产编号。 */
function resolveDeviceAssetCode(components: PlainObject): string {
  if (isPlainObject(components.telemetryBinding)) {
    const assetCode = readText(components.telemetryBinding.assetCode);
    if (assetCode) return assetCode;
  }
  return isPlainObject(components.modelAsset) ? readText(components.modelAsset.assetCode) : '';
}

/** 解析设备实体的设备类型：优先显式遥测绑定，回退模型包 dataDriven 配置。 */
function resolveDeviceType(components: PlainObject): string {
  if (isPlainObject(components.telemetryBinding)) {
    const deviceType = readText(components.telemetryBinding.deviceType);
    if (deviceType) return deviceType.toLowerCase();
  }
  if (isPlainObject(components.modelAsset) && isPlainObject(components.modelAsset.dataDrivenConfig)) {
    const dataDriven = components.modelAsset.dataDrivenConfig;
    if (isPlainObject(dataDriven.device)) return readText(dataDriven.device.devType).toLowerCase();
  }
  return '';
}

/** 按旧生成器绑定查找唯一设备实体；匹配失败返回 null 并记录告警。 */
function findDeviceByLegacyBinding(
  binding: LegacyGeneratorBinding,
  deviceEntries: Array<readonly [string, PlainObject]>,
  warnings: string[],
): PlainObject | null {
  if (!binding.assetCode) return null;
  const matches = deviceEntries.filter(([, components]) => {
    if (resolveDeviceAssetCode(components) !== binding.assetCode) return false;
    if (!binding.deviceType) return true;
    return resolveDeviceType(components) === binding.deviceType;
  });
  if (matches.length !== 1) {
    warnings.push(`旧绑定「${binding.assetCode}」匹配到 ${matches.length} 台设备，已跳过。`);
    return null;
  }
  return matches[0][1];
}

/** 确保设备实体存在原始遥测绑定对象，缺失时按旧绑定合成最小结构。 */
function ensureRawTelemetryBinding(components: PlainObject, binding: LegacyGeneratorBinding): PlainObject {
  if (!isPlainObject(components.telemetryBinding)) {
    components.telemetryBinding = {
      enabled: true,
      sourceId: binding.sourceId || 'default',
      deviceType: binding.deviceType || 'device',
      ...(binding.assetCode ? { assetCode: binding.assetCode } : {}),
    };
  }
  return components.telemetryBinding as PlainObject;
}

/**
 * 将 v1 场景的生成器设备绑定与仓储流配置迁移为 v2 结构：
 * bindings 反转为设备侧 cargoGeneratorId，warehouseFlow 三设备链转为 upstreamAssetCode。
 * 直接修改传入的原始场景对象，返回迁移摘要供 Console 输出。
 */
export function migrateLegacySceneV1ToV2(scene: PlainObject): MigrationSummary {
  const summary: MigrationSummary = { migratedCargoGenerators: 0, migratedUpstreams: 0, warnings: [] };
  if (!isPlainObject(scene.entities)) return summary;

  const generatorEntries: Array<readonly [string, PlainObject]> = [];
  const deviceEntries: Array<readonly [string, PlainObject]> = [];
  for (const [entityId, rawEntity] of Object.entries(scene.entities)) {
    if (!isPlainObject(rawEntity) || !isPlainObject(rawEntity.components)) continue;
    const components = rawEntity.components;
    if (isPlainObject(components.modelGenerator)) {
      generatorEntries.push([entityId, components.modelGenerator]);
    } else if (isPlainObject(components.modelAsset) || isPlainObject(components.telemetryBinding)) {
      deviceEntries.push([entityId, components]);
    }
  }

  for (const [generatorId, generator] of generatorEntries) {
    const legacyBindings = Array.isArray(generator.bindings)
      ? generator.bindings
          .filter(isPlainObject)
          .map((item) => ({
            id: readText(item.id),
            sourceId: readText(item.sourceId),
            deviceType: readText(item.deviceType).toLowerCase(),
            assetCode: readText(item.assetCode),
          }))
      : [];

    const devicesByBindingId = new Map<string, PlainObject>();
    for (const binding of legacyBindings) {
      const device = findDeviceByLegacyBinding(binding, deviceEntries, summary.warnings);
      if (!device) continue;
      ensureRawTelemetryBinding(device, binding).cargoGeneratorId = generatorId;
      summary.migratedCargoGenerators += 1;
      if (binding.id) devicesByBindingId.set(binding.id, device);
    }

    const flow = isPlainObject(generator.warehouseFlow) ? generator.warehouseFlow : null;
    if (flow?.enabled === true) {
      const bindingById = new Map(legacyBindings.map((binding) => [binding.id, binding]));
      const inbound = bindingById.get(readText(flow.inboundBindingId));
      const stacker = bindingById.get(readText(flow.stackerBindingId));
      const outbound = bindingById.get(readText(flow.outboundBindingId));
      const setUpstream = (deviceBinding: LegacyGeneratorBinding | undefined, upstreamBinding: LegacyGeneratorBinding | undefined, label: string) => {
        if (!deviceBinding || !upstreamBinding) return;
        const device = devicesByBindingId.get(deviceBinding.id);
        if (!device) {
          summary.warnings.push(`仓储流「${label}」设备「${deviceBinding.assetCode}」未匹配，跳过前置设备迁移。`);
          return;
        }
        ensureRawTelemetryBinding(device, deviceBinding).upstreamAssetCode = upstreamBinding.assetCode;
        summary.migratedUpstreams += 1;
      };
      setUpstream(stacker, inbound, '堆垛机');
      setUpstream(outbound, stacker, '出库输送机');
    }

    delete generator.bindings;
    delete generator.warehouseFlow;
  }

  return summary;
}

/** 输出迁移摘要到控制台，供编辑器 Console 面板镜像展示。 */
export function logLegacySceneMigrationSummary(summary: MigrationSummary): void {
  if (summary.migratedCargoGenerators === 0 && summary.migratedUpstreams === 0 && summary.warnings.length === 0) return;
  console.info(
    `[场景迁移] v1 → v2：反转设备绑定 ${summary.migratedCargoGenerators} 条，迁移前置设备 ${summary.migratedUpstreams} 条。`,
  );
  for (const warning of summary.warnings) {
    console.warn(`[场景迁移] ${warning}`);
  }
}
