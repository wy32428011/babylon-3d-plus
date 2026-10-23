/* global window, requestAnimationFrame */
import assert from 'node:assert/strict';

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** 新唯一入口的控制验证，不通过测试侧直接写灯光或外观配置。 */
export async function runUnifiedLightingControlsSmoke({ page, ui, capture, check }) {
  await ui.open('总览与烘焙');
  const manager = ui.manager;
  assert.equal(await manager.getByRole('combobox', { name: '阴影模式', exact: true }).count(), 0);
  assert.equal(await manager.getByRole('button', { name: '更新太阳阴影', exact: true }).count(), 0);
  assert.equal(await page.locator('.scene-theme-panel').count(), 0);
  const canonical = await page.evaluate(() => {
    const settings = window.lightingSmoke.store.getState().scene.sceneSettings;
    return { version: settings.lighting.version, appearance: settings.appearance.version,
      legacy: ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult'].filter(key => Object.hasOwn(settings, key)) };
  });
  assert.deepEqual(canonical, { version: 2, appearance: 1, legacy: [] });
  const activeLights = () => page.evaluate(() => window.lightingSmoke.runtime.scene.lights
    .filter(light => light.isEnabled() && light.intensity > 0).map(light => ({ id: light.id, intensity: light.intensity })).sort((a, b) => a.id.localeCompare(b.id)));
  const before = await activeLights();
  assert.ok(before.length > 0, '关闭阴影前必须有实际照明');
  await manager.getByRole('checkbox', { name: '启用阴影', exact: true }).uncheck();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await settle(page);
  assert.deepEqual(await activeLights(), before, '阴影开关不得创建或销毁照明光源');
  assert.equal(await page.evaluate(() => window.lightingSmoke.store.getState().scene.sceneSettings.lighting.shadows.enabled), false);
  await capture('editor-lighting-without-shadows');
  await manager.getByRole('checkbox', { name: '启用阴影', exact: true }).check();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await settle(page);
  assert.deepEqual(await activeLights(), before);
  check('统一配置实际生效，旧控制已移除，关闭阴影仍保留相同实际灯光');

  await manager.locator('summary').filter({ hasText: /^场景照明/ }).click();
  const beforePreset = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene));
  await manager.getByRole('combobox', { name: '光照预设', exact: true }).selectOption('industrial-daylight');
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), beforePreset);
  await manager.getByRole('combobox', { name: '光照预设', exact: true }).scrollIntoViewIfNeeded();
  await capture('manager-lighting-draft');
  await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await manager.getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
  await ui.open('总览与烘焙');
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene)), beforePreset);
  check('光照预设只暂存草稿，明确放弃后原照明与外观保持不变');
}

/** 在真实GI已绘制后修改曝光，验证配置、shader和实际结果的连续性。 */
export async function runUnifiedLightingAppearanceSmoke({ page, ui, capture, check }) {
  await ui.open('总览与烘焙');
  const snapshot = () => page.evaluate(async () => {
    const state = window.lightingSmoke, scene = state.runtime.scene;
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    const gl = scene.getEngine()._gl;
    const active = scene.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV'))
      .filter(mesh => mesh.subMeshes?.some(sub => {
        const effect = sub.effect, location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
        return effect?.defines.includes('#define BAKED_INDIRECT_MAP') && location && program && gl.getUniform(program, location) === 1;
      })).length;
    return { signature: getSceneLightingBakeSignature(state.store.getState().scene),
      resultSignature: state.store.getState().scene.sceneSettings.lighting.result?.signature,
      exposure: scene.imageProcessingConfiguration.exposure, active, error: state.runtime.getLightingBakeRuntimeError() };
  });
  await settle(page);
  const before = await snapshot();
  assert.ok(before.active > 0, '必须先实际绘制GI shader，不能只看资源清单');
  const summary = ui.manager.locator('summary').filter({ hasText: /^显示效果/ });
  await summary.click();
  const exposure = ui.manager.getByRole('spinbutton', { name: '曝光', exact: true });
  const next = before.exposure === 1.35 ? 1.1 : 1.35;
  await exposure.fill(String(next)); await exposure.press('Tab');
  await ui.manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
  await settle(page);
  const after = await snapshot();
  assert.equal(after.signature, before.signature);
  assert.equal(after.resultSignature, before.resultSignature);
  assert.equal(after.exposure, next);
  assert.equal(after.active, before.active);
  assert.equal(after.error, null);
  await summary.scrollIntoViewIfNeeded();
  await capture('manager-display-effects');
  check('实际UI调整曝光已生效，GI签名、shader及结果保持可用');
  await ui.close(); await page.keyboard.press('Control+z');
  await ui.open('总览与烘焙');
  await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
  await settle(page);
  const undone = await snapshot();
  assert.equal(undone.exposure, before.exposure);
  assert.equal(undone.signature, before.signature);
  assert.ok(undone.active > 0);
  assert.equal(undone.error, null);
}

/** 用真实HDR资源覆盖天空盒的对象/场景两个属性入口，确认照明强度只有统一管理器可改。 */
export async function runUnifiedSkyboxUiSmoke({ page, ui, skyboxPath, capture, check }) {
  await ui.close();
  const before = await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene.sceneSettings.lighting));
  const skyboxId = await page.evaluate(file => {
    const state = window.lightingSmoke.store.getState();
    state.placeSkybox({ packagePath: file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))),
      sourcePath: file, sourceUrl: 'editor-asset://local/' + encodeURIComponent(file), format: 'hdr',
      resolution: 512, rotationDegrees: 0, intensity: .15 }, { x: 0, y: 0, z: 0 });
    return window.lightingSmoke.store.getState().scene.selectedEntityId;
  }, skyboxPath);
  assert.ok(skyboxId);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.lightingSmoke.runtime.getSkyboxReadiness().phase), null, { timeout: 180_000 });
  const readiness = await page.evaluate(() => window.lightingSmoke.runtime.getSkyboxReadiness());
  assert.equal(readiness.phase, 'ready', JSON.stringify(readiness));
  assert.equal(await page.getByRole('spinbutton', { name: '环境强度', exact: true }).count(), 0);
  const expected = await page.evaluate(() => window.lightingSmoke.store.getState().scene.sceneSettings.lighting.environmentIntensity);
  assert.equal(Number(await page.getByLabel('环境反射强度', { exact: true }).textContent()), expected);
  assert.equal(await page.evaluate(() => window.lightingSmoke.runtime.scene.environmentIntensity), expected);
  await page.getByRole('button', { name: '在管理器中调整', exact: true }).click();
  await ui.manager.waitFor({ state: 'visible' });
  await capture('skybox-object-managed-lighting');
  await ui.close();
  await page.evaluate(() => window.lightingSmoke.store.getState().selectEntity(null));
  assert.equal(await page.getByRole('spinbutton', { name: '环境强度', exact: true }).count(), 0);
  assert.equal(Number(await page.getByLabel('环境反射强度', { exact: true }).textContent()), expected);
  await page.getByRole('button', { name: '在管理器中调整', exact: true }).click();
  await ui.manager.waitFor({ state: 'visible' });
  await capture('skybox-scene-managed-lighting');
  assert.equal(await page.evaluate(() => JSON.stringify(window.lightingSmoke.store.getState().scene.sceneSettings.lighting)), before);
  await ui.close();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(id => !window.lightingSmoke.store.getState().scene.entities[id]
    && window.lightingSmoke.runtime.getSkyboxReadiness().phase === 'idle', skyboxId);
  await ui.open('总览与烘焙');
  check('真实HDR天空盒的对象和场景属性均移除旧强度输入，统一跳转管理器且不改光照');
}
