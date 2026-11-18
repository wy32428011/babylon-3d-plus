import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  InspectionModelListItem,
  InspectionModelVersionListItem,
  InspectionModelVersionPreparationResult,
} from '../../../electron/types';
import { createId } from '../../shared/ids';
import type { ModelAssetComponent } from '../model/components';
import { inspectionConfigurationMatches, normalizeInspectionBinding, type InspectionBinding } from '../model/inspectionBinding';
import { areModelParameterValuesEqual, cloneModelParameterValues, type ModelParameterValues } from '../model/modelParameters';
import { useEditorStore } from '../store/editorStore';

type Props = { modelAsset: ModelAssetComponent; disabled?: boolean };
type DeviceDraft = { namespace: string; deviceType: string; deviceNo: string };
type Busy = 'models' | 'versions' | 'prepare' | null;
type PartsOrigin = 'saved' | 'resource' | 'unverified' | 'mismatch' | 'manual' | 'missing';

const emptyDevice = (): DeviceDraft => ({ namespace: '', deviceType: '', deviceNo: '' });
const showParts = (parts: InspectionBinding['parts'] | undefined) => JSON.stringify(parts ?? [], null, 2);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** 资源声明了参数快照时，只有与当前模型一致才能采用其零件清单。 */
export function inspectionResourceConfigurationMatches(
  prepared: InspectionModelVersionPreparationResult,
  current: ModelParameterValues | undefined,
): boolean {
  return !prepared.configuration || areModelParameterValuesEqual(prepared.configuration.parameters, current ?? {});
}

/** 拼装之前只接受已准备的资源；设备映射可以整体缺省，但不允许填写不完整。 */
export function createInspectionBindingFromFields(
  prepared: InspectionModelVersionPreparationResult | null,
  configuration: InspectionBinding['configuration'] | null,
  device: DeviceDraft,
  partsText: string,
): InspectionBinding {
  if (!prepared || !configuration) throw new Error('请先选择并准备固定高模版本。');
  let parts: unknown;
  try { parts = JSON.parse(partsText); }
  catch { throw new Error('零件规则不是有效的 JSON。'); }
  const deviceProvided = Object.values(device).some((value) => value !== '');
  return normalizeInspectionBinding({
    schemaVersion: 1,
    model: prepared.model,
    configuration,
    ...(deviceProvided ? { device } : {}),
    parts,
  });
}

/** 用户选择高模版本后，由受控主进程准备固定资源；规则和设备映射显式应用。 */
export function InspectionBindingInspector({ modelAsset, disabled = false }: Props) {
  const binding = modelAsset.inspection;
  const bindingSignature = useMemo(() => JSON.stringify(binding), [binding]);
  const update = useEditorStore((state) => state.updateSelectedInspectionBinding);
  const runtimeMode = useEditorStore((state) => state.runtimeMode);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
  const [models, setModels] = useState<InspectionModelListItem[]>([]);
  const [versions, setVersions] = useState<InspectionModelVersionListItem[]>([]);
  const [modelId, setModelId] = useState(binding?.model.dataPlatformModel.resourceId ?? '');
  const [versionId, setVersionId] = useState(binding?.model.versionId ?? '');
  const [prepared, setPrepared] = useState<InspectionModelVersionPreparationResult | null>(() =>
    binding ? { model: binding.model, parts: binding.parts } : null,
  );
  const [configuration, setConfiguration] = useState<InspectionBinding['configuration'] | null>(binding?.configuration ?? null);
  const [device, setDevice] = useState<DeviceDraft>(binding?.device ?? emptyDevice);
  const [partsText, setPartsText] = useState(() => showParts(binding?.parts));
  const [partsOrigin, setPartsOrigin] = useState<PartsOrigin>(binding ? 'saved' : 'missing');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  const request = useRef(0);
  const lastBinding = useRef(bindingSignature);
  const lastSession = useRef(sceneSessionId);
  const latestModelAsset = useRef(modelAsset);
  latestModelAsset.current = modelAsset;
  const errorRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const partHelpId = `${id}-parts-help`;
  const errorId = `${id}-error`;
  const snapshotMatches = !configuration || areModelParameterValuesEqual(configuration.parameters, modelAsset.parameterValues ?? {});
  const selectionMatches = !!prepared && prepared.model.dataPlatformModel.resourceId === modelId
    && prepared.model.versionId === versionId;

  useEffect(() => {
    mounted.current = true;
    const requestRef = request;
    return () => { mounted.current = false; requestRef.current++; };
  }, []);

  useEffect(() => {
    if (lastBinding.current === bindingSignature && lastSession.current === sceneSessionId) return;
    const sessionChanged = lastSession.current !== sceneSessionId;
    lastBinding.current = bindingSignature;
    lastSession.current = sceneSessionId;
    request.current++;
    setBusy(null);
    if (sessionChanged) { setModels([]); setVersions([]); }
    setModelId(binding?.model.dataPlatformModel.resourceId ?? '');
    setVersionId(binding?.model.versionId ?? '');
    setPrepared(binding ? { model: binding.model, parts: binding.parts } : null);
    setConfiguration(binding?.configuration ?? null);
    setDevice(binding?.device ?? emptyDevice());
    setPartsText(showParts(binding?.parts));
    setPartsOrigin(binding ? 'saved' : 'missing');
    setError('');
    setStatus('');
  }, [binding, bindingSignature, sceneSessionId]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  function begin(next: NonNullable<Busy>) {
    const sequence = ++request.current;
    const session = useEditorStore.getState().sceneSessionId;
    setBusy(next);
    setError('');
    setStatus('');
    return () => mounted.current && request.current === sequence && useEditorStore.getState().sceneSessionId === session;
  }

  async function loadModels(): Promise<void> {
    const api = window.editorApi;
    if (!api?.listInspectionModels) { setError('当前编辑器不支持读取高模版本，请更新桌面编辑器。'); return; }
    const active = begin('models');
    try {
      const result = await api.listInspectionModels();
      if (!active()) return;
      setModels(result);
      setStatus(result.length ? '已读取高模列表，请选择模型。' : '当前数据中台没有可选高模。');
    } catch (cause) { if (active()) setError(`读取高模列表失败：${message(cause)}`); }
    finally { if (active()) setBusy(null); }
  }

  async function loadVersions(): Promise<void> {
    const api = window.editorApi;
    if (!api?.listInspectionModelVersions) { setError('当前编辑器不支持查询高模版本，请更新桌面编辑器。'); return; }
    if (!modelId) { setError('请先选择高模。'); return; }
    const active = begin('versions');
    try {
      const result = await api.listInspectionModelVersions({ resourceId: modelId });
      if (!active()) return;
      setVersions(result);
      setStatus(result.length ? '已读取版本列表，请选择具体版本。' : '此高模没有可选版本。');
    } catch (cause) { if (active()) setError(`读取高模版本失败：${message(cause)}`); }
    finally { if (active()) setBusy(null); }
  }

  async function prepareVersion(): Promise<void> {
    const api = window.editorApi;
    if (!api?.prepareInspectionModelVersion) { setError('当前编辑器不支持准备固定高模，请更新桌面编辑器。'); return; }
    if (!modelId || !versionId) { setError('请先选择高模和具体版本。'); return; }
    const active = begin('prepare');
    try {
      const result = await api.prepareInspectionModelVersion({ resourceId: modelId, versionId });
      if (!active()) return;
      if (result.model.dataPlatformModel.resourceId !== modelId || result.model.versionId !== versionId) {
        throw new Error('准备结果与选择的模型版本不一致。');
      }
      const current = latestModelAsset.current;
      const previous = current.inspection;
      const sameVersion = !!previous && previous.model.dataPlatformModel.sourceKey === result.model.dataPlatformModel.sourceKey
        && previous.model.dataPlatformModel.resourceId === modelId && previous.model.versionId === versionId
        && previous.model.dataPlatformModel.modelPath === result.model.dataPlatformModel.modelPath
        && previous.model.contentSha256 === result.model.contentSha256;
      const resourceMatches = inspectionResourceConfigurationMatches(result, current.parameterValues);
      const canReuseConfiguration = !!previous && sameVersion && resourceMatches
        && inspectionConfigurationMatches(previous, current.parameterValues);
      const reusableParts = canReuseConfiguration ? previous.parts : undefined;
      const resourceParts = resourceMatches && result.parts?.length ? result.parts : undefined;
      const nextParts = resourceParts ?? reusableParts;
      setPrepared(result);
      setConfiguration(resourceMatches && result.configuration ? result.configuration : canReuseConfiguration ? previous.configuration : {
        id: createId('inspection_configuration'),
        parameters: cloneModelParameterValues(current.parameterValues ?? {}),
      });
      setPartsText(showParts(nextParts));
      setPartsOrigin(!resourceMatches ? 'mismatch' : resourceParts ? result.configuration ? 'resource' : 'unverified' : reusableParts ? 'saved' : 'missing');
      setStatus('固定模型版本已准备，请核对零件规则和设备映射后应用。');
    } catch (cause) { if (active()) setError(`准备固定版本失败：${message(cause)}`); }
    finally { if (active()) setBusy(null); }
  }

  function useCurrentParameters(): void {
    if (!prepared) return;
    setConfiguration({ id: createId('inspection_configuration'), parameters: cloneModelParameterValues(modelAsset.parameterValues ?? {}) });
    setPartsText(showParts(undefined));
    setPartsOrigin('missing');
    setError('');
    setStatus('已创建当前模型参数快照，请重新填写适用于该参数的零件规则。');
  }

  function apply(): void {
    try {
      if (!selectionMatches) throw new Error('选择的模型版本尚未准备，请先准备该版本。');
      const next = createInspectionBindingFromFields(prepared, configuration, device, partsText);
      if (!inspectionConfigurationMatches(next, modelAsset.parameterValues)) {
        throw new Error('固定配置参数与当前设备参数不匹配，请重新捕获当前参数。');
      }
      update(next);
      setError('');
      setStatus('详情绑定已应用。');
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <fieldset className="transform-fieldset" disabled={disabled || runtimeMode !== 'edit' || busy !== null}>
      <legend>高精度详情</legend>
      <p className="muted">从当前数据中台选择高模及具体版本。固定资源和完整包摘要由桌面编辑器校验后提供。</p>
      <button type="button" onClick={() => void loadModels()}>{busy === 'models' ? '正在读取高模…' : '读取高模列表'}</button>
      <label className="inspector-row" htmlFor={`${id}-model`}>
        <span>高模</span>
        <select id={`${id}-model`} aria-label="高模" value={modelId} onChange={(event) => {
          setModelId(event.target.value); setVersionId(''); setVersions([]); setError(''); setStatus('');
        }}>
          <option value="">请选择高模</option>
          {modelId && !models.some((item) => item.resourceId === modelId) ? <option value={modelId}>当前高模 {modelId}</option> : null}
          {models.map((item) => <option key={item.resourceId} value={item.resourceId}>{item.displayName}</option>)}
        </select>
      </label>
      <button type="button" disabled={!modelId} onClick={() => void loadVersions()}>{busy === 'versions' ? '正在读取版本…' : '读取模型版本'}</button>
      <label className="inspector-row" htmlFor={`${id}-version`}>
        <span>固定版本</span>
        <select id={`${id}-version`} aria-label="固定版本" value={versionId} onChange={(event) => {
          setVersionId(event.target.value); setError(''); setStatus('');
        }}>
          <option value="">请选择版本</option>
          {versionId && !versions.some((item) => item.versionId === versionId) ? <option value={versionId}>当前版本 {versionId}</option> : null}
          {versions.map((item) => <option key={item.versionId} value={item.versionId}>{item.label || item.versionId}</option>)}
        </select>
      </label>
      <button type="button" disabled={!modelId || !versionId} onClick={() => void prepareVersion()}>{busy === 'prepare' ? '正在准备固定版本…' : '准备固定版本'}</button>
      {prepared && selectionMatches ? <details><summary>检查固定资源</summary>
        <p>模型：{prepared.model.sourcePath}</p><p>元数据：{prepared.model.metaPath}</p>
        <p>完整资源包 SHA-256：{prepared.model.contentSha256}</p>
      </details> : null}
      {configuration && !snapshotMatches ? <p role="alert">固定配置参数与当前设备参数不匹配，请重新捕获当前参数。</p> : null}
      {configuration && !snapshotMatches ? <button type="button" onClick={useCurrentParameters}>捕获当前模型参数</button> : null}
      <label className="inspector-row" htmlFor={`${id}-namespace`}><span>设备命名空间</span>
        <input id={`${id}-namespace`} value={device.namespace} onChange={(event) => setDevice({ ...device, namespace: event.target.value })} />
      </label>
      <label className="inspector-row" htmlFor={`${id}-type`}><span>设备类型</span>
        <input id={`${id}-type`} value={device.deviceType} onChange={(event) => setDevice({ ...device, deviceType: event.target.value })} />
      </label>
      <label className="inspector-row" htmlFor={`${id}-number`}><span>设备编号</span>
        <input id={`${id}-number`} value={device.deviceNo} onChange={(event) => setDevice({ ...device, deviceNo: event.target.value })} />
      </label>
      <p className="muted">设备三项需全部填写；全部留空表示尚未绑定设备。</p>
      {binding && !binding.device ? <p role="status">设备未绑定，请填写真实设备映射。</p> : null}
      <label htmlFor={`${id}-parts`}>零件规则 JSON</label>
      <p id={partHelpId} className="muted">每项填写唯一 partKey、name、nodePath、世界方向 axis、distanceMeters 和 fixed；可选 parentPartKey。nodePath 的点代表加载根，其余路径以 / 逐层分隔。axis 为包含数值 x、y、z 的非零向量，distanceMeters 以米为单位，fixed 为 true 或 false。</p>
      <details><summary>查看零件规则格式</summary>
        <p className="muted">以下仅展示字段格式，使用前必须替换为高模中的真实零件和规则。</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`[{"partKey":"实际零件标识","name":"实际零件名称","nodePath":"实际节点路径","axis":{"x":1,"y":0,"z":0},"distanceMeters":0,"fixed":true}]`}</pre>
      </details>
      {partsOrigin === 'missing' ? <p role="status">资源未提供适用的零件规则，请根据实际高模填写。</p> : null}
      {partsOrigin === 'mismatch' ? <p role="alert">资源零件清单的参数快照与当前模型不匹配，不能使用该清单，请选择匹配版本或手工配置。</p> : null}
      {partsOrigin === 'unverified' ? <p role="status">资源未提供参数快照，请核对零件规则是否适用于当前模型参数。</p> : null}
      <textarea id={`${id}-parts`} rows={10} style={{ width: '100%', boxSizing: 'border-box' }}
        value={partsText} onChange={(event) => { setPartsText(event.target.value); setPartsOrigin('manual'); setError(''); }}
        aria-describedby={error ? `${partHelpId} ${errorId}` : partHelpId} spellCheck={false} />
      {error ? <p ref={errorRef} id={errorId} role="alert" tabIndex={-1}>{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      <div>
        <button type="button" disabled={!selectionMatches || !snapshotMatches} onClick={apply}>应用详情绑定</button>
        {binding ? <button type="button" onClick={() => update(null)}>移除详情绑定</button> : null}
      </div>
    </fieldset>
  );
}
