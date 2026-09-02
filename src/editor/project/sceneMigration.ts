type PlainObject = Record<string, unknown>;

type LegacyGeneratorBinding = {
  id: string;
  sourceId: string;
  deviceType: string;
  assetCode: string;
};

type MigrationSummary = {
  migratedCargoGenerators: number;
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
 * 将 v1 场景的生成器设备绑定迁移为 v2 结构：bindings 反转为设备侧 cargoGeneratorId，
 * warehouseFlow 旧字段随前置设备概念一并丢弃。
 * 直接修改传入的原始场景对象，返回迁移摘要供 Console 输出。
 */
export function migrateLegacySceneV1ToV2(scene: PlainObject): MigrationSummary {
  const summary: MigrationSummary = { migratedCargoGenerators: 0, warnings: [] };
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

    for (const binding of legacyBindings) {
      const device = findDeviceByLegacyBinding(binding, deviceEntries, summary.warnings);
      if (!device) continue;
      ensureRawTelemetryBinding(device, binding).cargoGeneratorId = generatorId;
      summary.migratedCargoGenerators += 1;
    }

    delete generator.bindings;
    delete generator.warehouseFlow;
  }

  return summary;
}

/** 输出迁移摘要到控制台，供编辑器 Console 面板镜像展示。 */
export function logLegacySceneMigrationSummary(summary: MigrationSummary): void {
  if (summary.migratedCargoGenerators === 0 && summary.warnings.length === 0) return;
  console.info(
    `[场景迁移] v1 → v2：反转设备绑定 ${summary.migratedCargoGenerators} 条。`,
  );
  for (const warning of summary.warnings) {
    console.warn(`[场景迁移] ${warning}`);
  }
}

type SceneV2ToV3MigrationSummary = {
  migratedFetchDrives: number;
  warnings: string[];
};

/**
 * 将 v2 场景的生成器 fetch 配置迁移为 v3 结构：
 * fetchBindings 反转为定位线框侧 fetchDrive.cargoGeneratorId，生成器退化为纯模板库。
 * 直接修改传入的原始场景对象，返回迁移摘要供 Console 输出。
 * 注意：只要 fetchBindings 非空即迁移，不检查 dataSource——v2 UI 切回 mqtt 只隐藏不清空绑定，数据仍是有效配置意图。
 */
export function migrateSceneV2ToV3(scene: PlainObject): SceneV2ToV3MigrationSummary {
  const summary: SceneV2ToV3MigrationSummary = { migratedFetchDrives: 0, warnings: [] };
  if (!isPlainObject(scene.entities)) return summary;

  const generatorEntries: Array<readonly [string, PlainObject]> = [];
  const locatorEntries: Array<readonly [string, PlainObject]> = [];
  for (const [entityId, rawEntity] of Object.entries(scene.entities)) {
    if (!isPlainObject(rawEntity) || !isPlainObject(rawEntity.components)) continue;
    const components = rawEntity.components;
    if (isPlainObject(components.modelGenerator)) {
      generatorEntries.push([entityId, components.modelGenerator]);
    }
    if (isPlainObject(components.locator)) {
      locatorEntries.push([entityId, components.locator]);
    }
  }

  for (const [generatorId, generator] of generatorEntries) {
    const fetchBindings = Array.isArray(generator.fetchBindings) ? generator.fetchBindings.filter(isPlainObject) : [];
    for (const binding of fetchBindings) {
      const assetCode = readText(binding.assetCode);
      if (!assetCode) continue;
      const matches = locatorEntries.filter(([, locator]) => readText(locator.assetId) === assetCode);
      if (matches.length !== 1) {
        summary.warnings.push(`fetch 绑定「${assetCode}」匹配到 ${matches.length} 个定位线框，已跳过。`);
        continue;
      }
      const locator = matches[0][1];
      if (isPlainObject(locator.fetchDrive)) {
        summary.warnings.push(`定位线框「${assetCode}」已被其他生成器绑定，保留首个，跳过生成器 ${generatorId} 的绑定。`);
        continue;
      }
      locator.fetchDrive = { enabled: true, cargoGeneratorId: generatorId };
      summary.migratedFetchDrives += 1;
    }

    delete generator.fetchBindings;
    delete generator.dataSource;
    delete generator.metadataTtlSeconds;
  }

  return summary;
}

/** 输出 v2 → v3 迁移摘要到控制台。 */
export function logSceneV2ToV3MigrationSummary(summary: SceneV2ToV3MigrationSummary): void {
  if (summary.migratedFetchDrives === 0 && summary.warnings.length === 0) return;
  console.info(`[场景迁移] v2 → v3：反转 fetch 定位线框绑定 ${summary.migratedFetchDrives} 条，生成器转为纯模板库。`);
  for (const warning of summary.warnings) {
    console.warn(`[场景迁移] ${warning}`);
  }
}

type SceneV3ToV4MigrationSummary = {
  migratedScreens: number;
  warnings: string[];
};

/**
 * 将早期试验版大屏组件字段迁移到 v4 的稳定命名：mode → renderMode、width/height → widthMeters/heightMeters。
 * 迁移只处理明确存在的字段，不为普通实体补造大屏组件。
 */
export function migrateSceneV3ToV4(scene: PlainObject): SceneV3ToV4MigrationSummary {
  const summary: SceneV3ToV4MigrationSummary = { migratedScreens: 0, warnings: [] };
  if (!isPlainObject(scene.entities)) return summary;

  for (const rawEntity of Object.values(scene.entities)) {
    if (!isPlainObject(rawEntity) || !isPlainObject(rawEntity.components)) continue;
    const screen = rawEntity.components.dataPlatformScreen;
    if (!isPlainObject(screen)) continue;

    let migrated = false;
    if (screen.renderMode === undefined && (screen.mode === 'iframe' || screen.mode === 'texture')) {
      screen.renderMode = screen.mode;
      migrated = true;
    }
    if (screen.widthMeters === undefined && typeof screen.width === 'number') {
      screen.widthMeters = screen.width;
      migrated = true;
    }
    if (screen.heightMeters === undefined && typeof screen.height === 'number') {
      screen.heightMeters = screen.height;
      migrated = true;
    }

    if (migrated) summary.migratedScreens += 1;
    delete screen.mode;
    delete screen.width;
    delete screen.height;
  }

  return summary;
}

/** 输出 v3 → v4 大屏组件迁移摘要。 */
export function logSceneV3ToV4MigrationSummary(summary: SceneV3ToV4MigrationSummary): void {
  if (summary.migratedScreens === 0 && summary.warnings.length === 0) return;
  console.info(`[场景迁移] v3 → v4：迁移数据中台大屏组件 ${summary.migratedScreens} 个。`);
  for (const warning of summary.warnings) console.warn(`[场景迁移] ${warning}`);
}

type SceneV4ToV5MigrationSummary = {
  defaultedViewportScreen: boolean;
  warnings: string[];
};

/** v4 没有视窗级完整大屏配置；升级时显式补齐关闭状态，避免旧场景依赖 undefined。 */
export function migrateSceneV4ToV5(scene: PlainObject): SceneV4ToV5MigrationSummary {
  const summary: SceneV4ToV5MigrationSummary = { defaultedViewportScreen: false, warnings: [] };
  if (!isPlainObject(scene.sceneSettings)) return summary;
  if (scene.sceneSettings.viewportScreen !== undefined) return summary;
  scene.sceneSettings.viewportScreen = null;
  summary.defaultedViewportScreen = true;
  return summary;
}

/** 输出 v4 → v5 视窗大屏配置迁移摘要。 */
export function logSceneV4ToV5MigrationSummary(summary: SceneV4ToV5MigrationSummary): void {
  if (!summary.defaultedViewportScreen && summary.warnings.length === 0) return;
  if (summary.defaultedViewportScreen) console.info('[场景迁移] v4 → v5：已补齐视窗级大屏配置（默认关闭）。');
  for (const warning of summary.warnings) console.warn(`[场景迁移] ${warning}`);
}
