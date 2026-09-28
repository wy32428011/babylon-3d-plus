import { useEffect, useRef, useState } from 'react';
import {
  getOpeningPackageProblem, validateOpeningPackageConfig, type OpeningPackageBinding, type OpeningPackageConfig,
} from '../../shared/opening/openingPackage';
import { normalizeSceneOpeningAnimation } from '../model/sceneOpeningAnimation';
import { useEditorStore } from '../store/editorStore';
import { OpeningPackageFields } from './OpeningPackageFields';
import { OpeningStageEditor } from './OpeningStageEditor';
import './OpeningPackagePanel.css';

const keyOf = (binding: OpeningPackageBinding) => `${binding.id}@${binding.version}:${binding.contentHash}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 工程资源库的导入和当前场景应用是两次独立操作。 */
export function OpeningPackagePanel({ disabled, sceneSessionId }: { disabled: boolean; sceneSessionId: string }) {
  const stored = useEditorStore(state => state.scene.sceneSettings.openingAnimation);
  const update = useEditorStore(state => state.updateSceneOpeningAnimation);
  const settings = normalizeSceneOpeningAnimation(stored);
  const [packages, setPackages] = useState<OpeningPackageBinding[]>([]);
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);
  const loadSequence = useRef(0);
  const session = useRef(sceneSessionId); session.current = sceneSessionId;
  const mounted = useRef(true);
  const binding = settings.template === 'package' ? settings.package : undefined;
  const problem = settings.template === 'package' ? getOpeningPackageProblem(binding) : null;
  const valid = binding && !problem ? binding : undefined;
  const selected = packages.find(item => keyOf(item) === selection);
  const available = Boolean(window.editorApi?.listOpeningPackages);
  const currentSession = () => mounted.current && session.current === sceneSessionId && useEditorStore.getState().sceneSessionId === sceneSessionId;
  const canEdit = () => !disabled && currentSession() && useEditorStore.getState().runtimeMode !== 'preview';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current++; }; }, []);
  useEffect(() => {
    setPackages([]); setSelection(''); setStatus(null); setBusy(false); setInventoryLoaded(false);
    if (!window.editorApi?.listOpeningPackages) return;
    const sequence = ++loadSequence.current;
    void window.editorApi.listOpeningPackages().then(result => {
      if (!mounted.current || sequence !== loadSequence.current || session.current !== sceneSessionId) return;
      setPackages(result.packages); setSelection(result.packages[0] ? keyOf(result.packages[0]) : ''); setInventoryLoaded(true);
      if (result.warnings.length) setStatus({ message: result.warnings.join('；'), error: true });
    }).catch(error => {
      if (mounted.current && sequence === loadSequence.current) setStatus({ message: `读取开场资源库失败：${errorText(error)}`, error: true });
    });
  }, [sceneSessionId]);

  async function importPackage() {
    if (!canEdit() || busy || !window.editorApi?.importOpeningPackage) return;
    loadSequence.current++; setBusy(true); setStatus(null);
    try {
      const result = await window.editorApi.importOpeningPackage();
      if (!currentSession() || result.canceled) return;
      if (!result.package) throw new Error('导入未返回可用的开场包。');
      setPackages(result.packages); setInventoryLoaded(true);
      setSelection(keyOf(result.package));
      setStatus({ message: `开场包已导入工程资源库。点击“应用到当前场景”后开始配置。${result.warnings.length ? ` ${result.warnings.join('；')}` : ''}`, error: result.warnings.length > 0 });
    } catch (error) { if (currentSession()) setStatus({ message: `导入失败：${errorText(error)}`, error: true }); }
    finally { if (currentSession()) setBusy(false); }
  }
  function applyPackage(preserve: boolean) {
    if (!canEdit() || !selected) return;
    try {
      const applied = structuredClone(selected);
      if (preserve && valid && valid.id === selected.id) {
        for (const key of Object.keys(applied.config.values)) {
          if (Object.hasOwn(valid.config.values, key)) applied.config.values[key] = structuredClone(valid.config.values[key]);
        }
        const previousDefaults = new Set(valid.definition.timeline.stages.map(stage => stage.id));
        applied.config.stages = [...structuredClone(valid.config.stages), ...applied.config.stages.filter(stage => !previousDefaults.has(stage.id))];
        applied.config.assetOverrides = Object.fromEntries(Object.entries(valid.config.assetOverrides ?? {})
          .filter(([id]) => applied.definition.manifest.assets.some(asset => asset.id === id)));
        validateOpeningPackageConfig(applied.definition, applied.config);
      }
      const error = getOpeningPackageProblem(applied); if (error) throw new Error(error);
      update({ template: 'package', package: applied });
      setStatus({ message: `已应用 ${applied.definition.manifest.name} ${applied.version}，参数仅属于当前场景。`, error: false });
    } catch (error) { setStatus({ message: `应用失败，当前配置已保留：${errorText(error)}`, error: true }); }
  }
  function updateConfig(config: OpeningPackageConfig) {
    if (!canEdit() || !valid) return;
    const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation);
    if (current.template !== 'package' || !current.package || keyOf(current.package) !== keyOf(valid)) return;
    try {
      validateOpeningPackageConfig(valid.definition, config);
      update({ package: { ...current.package, config } }); setStatus(null);
    } catch (error) { setStatus({ message: `配置未保存：${errorText(error)}`, error: true }); }
  }
  async function replaceAsset(assetId: string) {
    if (!canEdit() || !valid || busy || !window.editorApi?.importOpeningAsset) return;
    const startingKey = keyOf(valid); setBusy(true);
    try {
      const result = await window.editorApi.importOpeningAsset();
      if (!canEdit() || result.canceled || !result.assetUrl || !result.sha256 || !result.size) return;
      const current = normalizeSceneOpeningAnimation(useEditorStore.getState().scene.sceneSettings.openingAnimation).package;
      if (!current || keyOf(current) !== startingKey) return;
      updateConfig({ ...current.config, assetOverrides: { ...current.config.assetOverrides,
        [assetId]: { assetUrl: result.assetUrl, size: result.size, sha256: result.sha256 } } });
    } catch (error) { if (currentSession()) setStatus({ message: `导入素材失败：${errorText(error)}`, error: true }); }
    finally { if (currentSession()) setBusy(false); }
  }
  async function exportPackage() {
    if (!selected || busy || !window.editorApi?.exportOpeningPackage) return;
    setBusy(true);
    try {
      const result = await window.editorApi.exportOpeningPackage({ id: selected.id, version: selected.version, contentHash: selected.contentHash });
      if (currentSession() && !result.canceled) setStatus({ message: '原始开场包已导出，当前场景的独立配置随场景文件保存。', error: false });
    } catch (error) { if (currentSession()) setStatus({ message: `导出失败：${errorText(error)}`, error: true }); }
    finally { if (currentSession()) setBusy(false); }
  }
  return <div className="opening-package-panel">
    <div className="opening-package-library">
      <strong>工程开场资源库</strong>
      <div className="scene-settings-button-row">
        <button type="button" disabled={disabled || busy || !available} onClick={() => void importPackage()}>{busy ? '正在处理…' : '导入开场包'}</button>
        <button type="button" disabled={busy || !selected || !available} onClick={() => void exportPackage()}>导出所选原包</button>
      </div>
      <label className="inspector-row"><span>开场包版本</span><select aria-label="开场包版本" value={selection} disabled={busy || !packages.length}
        onChange={event => setSelection(event.target.value)}><option value="">选择工程中的开场包</option>
        {packages.map(item => <option key={keyOf(item)} value={keyOf(item)}>{item.definition.manifest.name} · {item.version}</option>)}
      </select></label>
      {selected ? <><p className="muted">{selected.definition.manifest.description}</p>
        <p className="opening-package-identity">{selected.id} · {selected.version}</p>
        <div className="scene-settings-button-row">
          <button type="button" disabled={disabled || busy} onClick={() => applyPackage(false)}>应用到当前场景</button>
          {valid && valid.id === selected.id ? <button type="button" disabled={disabled || busy} onClick={() => applyPackage(true)}>
            {keyOf(valid) === keyOf(selected) ? '重新关联并保留配置' : '升级并保留兼容配置'}
          </button> : null}
        </div><p className="muted">应用使用包的默认参数；升级会校验并保留同名参数和同 ID 分镜。已有场景保持固定版本。</p>
      </> : null}
      {!available ? <p className="muted">开场包导入和工程资源库需要桌面编辑器。</p> : null}
      {settings.template === 'package' ? <button type="button" disabled={disabled || busy} onClick={() => {
        if (canEdit()) update({ template: 'reference-huishan' });
      }}>使用原参考模板</button> : null}
    </div>
    {status ? <p className="opening-package-status" role={status.error ? 'alert' : 'status'}>{status.message}</p> : null}
    {problem ? <p className="opening-package-status" role="alert">{problem}。原配置已保留，请重新导入所需版本或应用其它开场包。</p> : null}
    {valid && inventoryLoaded && !packages.some(item => keyOf(item) === keyOf(valid)) ? <p className="opening-package-status" role="alert">
      当前场景引用的开场包缺失或不可用，请重新导入 {valid.id} {valid.version} 对应的原始包。场景配置已保留。
    </p> : null}
    {valid ? <div key={keyOf(valid)}>
      <p className="opening-package-identity">当前场景：{valid.definition.manifest.name} · {valid.version} · {valid.contentHash.slice(0, 12)}</p>
      <OpeningPackageFields binding={valid} disabled={disabled || busy} onChange={(key, value) => updateConfig({ ...valid.config, values: { ...valid.config.values, [key]: value } })} />
      {valid.definition.manifest.assets.length ? <details><summary>场景独立素材（{valid.definition.manifest.assets.length}）</summary>
        <p className="muted">替换素材只影响当前场景；更换底图后请校准飞线点位。</p>
        {valid.definition.manifest.assets.filter(asset => asset.type === 'image').map(asset => <div key={asset.id} className="opening-package-asset-actions">
          <span>{asset.id}{valid.config.assetOverrides?.[asset.id] ? '（已替换）' : ''}</span>
          <button type="button" aria-label={`替换素材 ${asset.id}`} disabled={disabled || busy || !available} onClick={() => void replaceAsset(asset.id)}>导入替换图片</button>
          {valid.config.assetOverrides?.[asset.id] ? <button type="button" aria-label={`恢复素材 ${asset.id}`} disabled={disabled || busy} onClick={() => {
            const assetOverrides = { ...valid.config.assetOverrides }; delete assetOverrides[asset.id]; updateConfig({ ...valid.config, assetOverrides });
          }}>恢复包内素材</button> : null}
        </div>)}
      </details> : null}
      <details open><summary>分镜与飞线</summary><OpeningStageEditor binding={valid} disabled={disabled || busy} onChange={updateConfig} /></details>
      <button type="button" disabled={disabled || busy} onClick={() => updateConfig({ ...valid.config, values: structuredClone(valid.definition.defaults) })}>恢复包默认参数</button>
    </div> : null}
  </div>;
}
