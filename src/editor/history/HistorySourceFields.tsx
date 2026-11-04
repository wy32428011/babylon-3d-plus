import { useEffect, useId, useState } from 'react';
import type { HistoryJson, HistorySourceKind } from '../../../electron/shared/historyServiceContract';
import { compileHistoryMqttFieldMap } from '../../runtime/history/mqttFieldMap';
import type {
  HistoryHttpMapping, HistoryHttpOperation, HistoryHttpSourceConfig,
  HistoryMqttParser, HistoryMqttSourceConfig, HistorySourceConfig, HistorySourceCredential,
} from '../../../electron/shared/historySourceConfig';

const EMPTY_MAP = {};
export type InvalidFieldHandler = (field: string, message: string | null) => void;

type JsonFieldProps = {
  field: string; label: string; value: HistoryJson | undefined;
  kind?: 'json' | 'object' | 'string-map' | 'mqtt-field-map'; hint?: string;
  onChange: (value: HistoryJson) => void; onInvalid: InvalidFieldHandler;
};

/** 无效 JSON 保留在输入框，但阻止保存，不能静默提交上一次有效值。 */
export function HistoryJsonField({ field, label, value, kind = 'json', hint, onChange, onInvalid }: JsonFieldProps) {
  const serialized = JSON.stringify(value ?? null, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => { setDraft(serialized); setError(null); onInvalid(field, null); }, [serialized, field, onInvalid]);
  useEffect(() => () => onInvalid(field, null), [field, onInvalid]);
  return <label className="history-settings-field history-settings-wide" htmlFor={id}>
    <span>{label}</span>
    <textarea id={id} rows={4} spellCheck={false} value={draft} aria-invalid={Boolean(error)} aria-describedby={`${id}-help`}
      onChange={event => {
        const next = event.target.value;
        setDraft(next);
        try {
          if (next.length > 131_072) throw new Error('字段内容超过 128 KiB 字符预算。');
          const parsed: unknown = JSON.parse(next);
          if (kind !== 'json' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('此字段需要 JSON 对象。');
          if (kind === 'string-map' && Object.values(parsed as object).some(item => typeof item !== 'string')) throw new Error('映射值必须是字符串。');
          if (kind === 'mqtt-field-map') compileHistoryMqttFieldMap(parsed);
          setError(null); onInvalid(field, null); onChange(parsed as HistoryJson);
        } catch (reason) {
          const message = reason instanceof SyntaxError ? 'JSON 格式不正确，请补齐括号、引号或逗号。' : reason instanceof Error ? reason.message : '字段无效。';
          setError(message); onInvalid(field, message);
        }
      }} />
    <small id={`${id}-help`} className={error ? 'history-settings-error' : undefined}>{error ?? hint}</small>
  </label>;
}

const MQTT_PATHS: readonly [keyof HistoryMqttParser, string][] = [
  ['recordsPath', '记录列表'], ['deviceTypePath', '设备类型'], ['deviceIdPath', '设备编号'],
  ['statePath', '状态对象'], ['eventTimePath', '来源事件时间'], ['sequencePath', '来源序号'],
  ['epochPath', '设备纪元'], ['eventIdPath', '事件身份'],
];
const HTTP_PATHS: readonly [keyof HistoryHttpMapping, string][] = [
  ['itemsPath', '记录列表'], ['statePath', '全态基线'], ['snapshotRevisionPath', '稳定快照修订'],
  ['nextCursorPath', '下一页游标'], ['donePath', '分页完成'], ['fromPath', '覆盖起点'], ['toPath', '覆盖终点'],
  ['gapsPath', '缺口列表'], ['completeThroughPath', '完整水位'], ['completenessPath', '完整性状态'],
  ['baselineTimePath', '实际基线时间'], ['eventCursorPath', '基线接续游标'], ['eventIdPath', '事件身份'],
  ['eventTimePath', '事件时间'], ['eventTypePath', '事件类型'], ['sequencePath', '同刻序号'],
  ['epochPath', '设备纪元'], ['versionIntervalsPath', '版本区间'],
];
const OPERATION_LABELS = { latest: '当前采集', coverage: '覆盖范围', baseline: '完整基线', events: '历史事件' } as const;
type OperationName = keyof typeof OPERATION_LABELS;
const OPERATION_NAMES = Object.keys(OPERATION_LABELS) as OperationName[];
const DEFAULT_OPERATION: HistoryHttpOperation = { method: 'GET', path: '', readOnly: true, mapping: {} };

export function HistorySourceFields(props: {
  kind: HistorySourceKind; config: HistorySourceConfig; identityLocked?: boolean;
  onChange: (value: HistorySourceConfig) => void; onInvalid: InvalidFieldHandler;
}) {
  const { kind, config, onChange, onInvalid } = props;
  if (kind === 'platform') return <p className="history-settings-note">使用当前项目的后台历史服务。平台地址由工程绑定解析，不填写独立回放 URL。</p>;
  const common = config as HistoryMqttSourceConfig | HistoryHttpSourceConfig;
  return <>
    <div className="history-settings-grid">
      <label className="history-settings-field"><span>逻辑来源 ID</span><input disabled={props.identityLocked} value={common.logicalSourceId} onChange={event => onChange({ ...common, logicalSourceId: event.target.value })} required maxLength={128} /></label>
      <label className="history-settings-field"><span>权威业务域</span><input disabled={props.identityLocked} value={common.authorityScope} onChange={event => onChange({ ...common, authorityScope: event.target.value })} placeholder="例如 warehouse-a/device" required maxLength={256} /></label>
    </div>
    {kind === 'mqtt'
      ? <MqttFields config={config as HistoryMqttSourceConfig} onChange={onChange} onInvalid={onInvalid} />
      : <HttpFields kind={kind} config={config as HistoryHttpSourceConfig} onChange={onChange} onInvalid={onInvalid} />}
  </>;
}

function MqttFields({ config, onChange, onInvalid }: { config: HistoryMqttSourceConfig; onChange: (value: HistoryMqttSourceConfig) => void; onInvalid: InvalidFieldHandler }) {
  const setParser = (value: Partial<HistoryMqttParser>) => {
    const parser = { ...config.parser, ...value }, entries = parser as unknown as Record<string, unknown>;
    for (const key of Object.keys(entries)) if (entries[key] === undefined) delete entries[key];
    onChange({ ...config, parser });
  };
  return <>
    <label className="history-settings-field"><span>服务器 Broker 地址</span><input value={config.brokerUri} onChange={event => onChange({ ...config, brokerUri: event.target.value })} placeholder="ssl://broker.example.com:8883" required />
      <small>使用服务器可达的协议与端口；不会把浏览器 WebSocket 地址自动改写为 TCP。</small></label>
    <fieldset><legend>只读订阅</legend>
      {config.topics.map((topic, index) => <div className="history-settings-row" key={index}>
        <input aria-label={`Topic ${index + 1}`} value={topic.filter} onChange={event => onChange({ ...config, topics: config.topics.map((entry, i) => i === index ? { ...entry, filter: event.target.value } : entry) })} placeholder="warehouse/+/state" required />
        <select aria-label={`QoS ${index + 1}`} value={topic.qos} onChange={event => onChange({ ...config, topics: config.topics.map((entry, i) => i === index ? { ...entry, qos: Number(event.target.value) as 0 | 1 | 2 } : entry) })}>
          <option value={0}>QoS 0</option><option value={1}>QoS 1</option><option value={2}>QoS 2</option>
        </select>
        <button type="button" disabled={config.topics.length <= 1} onClick={() => onChange({ ...config, topics: config.topics.filter((_, i) => i !== index) })}>移除</button>
      </div>)}
      <button type="button" disabled={config.topics.length >= 64} onClick={() => onChange({ ...config, topics: [...config.topics, { filter: '', qos: 1 }] })}>添加订阅</button>
    </fieldset>
    <div className="history-settings-grid">
      <label className="history-settings-field"><span>解析协议</span><select value={config.parser.adapter} onChange={event => setParser({ adapter: event.target.value as HistoryMqttParser['adapter'] })}><option value="epv-v1">EPV（e/p/v）</option><option value="json-v1">JSON 字段映射</option></select></label>
      <label className="history-settings-field"><span>帧语义</span><select value={config.parser.mode} onChange={event => setParser({ mode: event.target.value as 'full' | 'delta' })}><option value="full">完整帧</option><option value="delta">增量字段</option></select></label>
      <label className="history-settings-field"><span>固定设备类型（可选）</span><input value={config.parser.deviceType ?? ''} onChange={event => setParser({ deviceType: event.target.value || undefined })} placeholder="stacker / conveyor / …" /></label>
      <label className="history-settings-field"><span>时间口径</span><select value={config.parser.timeBasis} onChange={event => setParser({ timeBasis: event.target.value as 'observed' | 'source' })}><option value="observed">平台观测时间</option><option value="source">来源事件时间</option></select></label>
      <label className="history-settings-field"><span>时间单位（UTC）</span><select value={config.parser.timeUnit} onChange={event => setParser({ timeUnit: event.target.value as 'ms' | 's' })}><option value="ms">毫秒</option><option value="s">秒</option></select></label>
      <label className="history-settings-field"><span>设备序号纪元</span><select value={config.parser.epochMode} onChange={event => setParser(event.target.value === 'field' ? { epochMode: 'field' } : { epochMode: 'none', epochPath: undefined })}><option value="none">来源未提供</option><option value="field">显式字段</option></select></label>
    </div>
    <details><summary>身份、事件与状态映射</summary><p className="history-settings-note">使用 RFC6901 JSON Pointer，例如 /device/id。网络重连不代表设备序号重启。</p>
      <div className="history-settings-grid">{MQTT_PATHS.map(([key, label]) => <label className="history-settings-field" key={key}><span>{label}</span><input disabled={key === 'epochPath' && config.parser.epochMode === 'none'} value={String(config.parser[key] ?? '')} onChange={event => setParser({ [key]: event.target.value })} placeholder="/field/path" /></label>)}</div>
      <HistoryJsonField field="mqtt.fieldMap" label="点位映射（规范点位名 → 来源字段路径）" kind="mqtt-field-map" value={config.parser.fieldMap ?? EMPTY_MAP} onInvalid={onInvalid}
        onChange={value => setParser({ fieldMap: value as Record<string, string> })}
        hint={'路径相对于所选状态对象，例如 {"front_task":"/taskId"}；未映射字段保留，缺失字段不会补造。'} />
    </details>
  </>;
}

function HttpFields({ kind, config, onChange, onInvalid }: { kind: HistorySourceKind; config: HistoryHttpSourceConfig; onChange: (value: HistoryHttpSourceConfig) => void; onInvalid: InvalidFieldHandler }) {
  const setOperation = (name: OperationName, operation: HistoryHttpOperation) => onChange({ ...config, operations: { ...config.operations, [name]: operation } });
  const setSemantics = (patch: Partial<HistoryHttpSourceConfig['semantics']>) => onChange({ ...config, semantics: { ...config.semantics, ...patch } });
  return <>
    <label className="history-settings-field"><span>基础地址</span><input value={config.baseUrl} onChange={event => onChange({ ...config, baseUrl: event.target.value })} placeholder="https://history.example.com" required />
      <small>地址中不得嵌入认证信息；目标须经服务器出站策略批准。</small></label>
    <div className="history-settings-grid">
      <label className="history-settings-field"><span>时间口径</span><select value={config.semantics.timeBasis} onChange={event => setSemantics({ timeBasis: event.target.value as 'source' | 'observed' })}><option value="source">来源事件时间</option>{kind !== 'external-http' && <option value="observed">平台观测时间</option>}</select></label>
      <label className="history-settings-field"><span>时间单位（UTC）</span><select value={config.semantics.timeUnit} onChange={event => setSemantics({ timeUnit: event.target.value as 'ms' | 's' })}><option value="ms">毫秒</option><option value="s">秒</option></select></label>
      <label className="history-settings-field"><span>合法空结果含义</span><select value={config.semantics.emptyResult} onChange={event => setSemantics({ emptyResult: event.target.value as 'empty' | 'unchanged' })}><option value="unchanged">没有变化</option><option value="empty">明确为空</option></select></label>
      {kind === 'http' && <label className="history-settings-field"><span>轮询间隔（秒）</span><input type="number" min={1} max={86400} value={Number.isFinite(config.pollIntervalSeconds ?? 30) ? (config.pollIntervalSeconds ?? 30) : ''} onChange={event => onChange({ ...config, pollIntervalSeconds: event.currentTarget.valueAsNumber })} /></label>}
    </div>
    <p className="history-settings-note">查询区间为 [from, to)，排序为时间 → 序号 → 事件身份。外部源必须提供稳定修订、全态基线和有序事件，不能用请求时间冒充历史时间。</p>
    {OPERATION_NAMES.map(name => {
      const operation = config.operations[name];
      const required = kind === 'external-http' && name !== 'latest';
      return <fieldset key={name}>
        <legend><label><input type="checkbox" checked={Boolean(operation)} disabled={required} onChange={event => {
          const operations = { ...config.operations };
          if (event.target.checked) operations[name] = { ...DEFAULT_OPERATION, mapping: {} }; else delete operations[name];
          onChange({ ...config, operations });
        }} /> {OPERATION_LABELS[name]}{required ? '（必需）' : ''}</label></legend>
        {operation && <>
          <div className="history-settings-row">
            <select aria-label={`${OPERATION_LABELS[name]}方法`} value={operation.method} onChange={event => setOperation(name, { ...operation, method: event.target.value as 'GET' | 'POST' })}><option>GET</option><option>POST</option></select>
            <input aria-label={`${OPERATION_LABELS[name]}路径`} value={operation.path} onChange={event => setOperation(name, { ...operation, path: event.target.value })} placeholder="/api/history" required />
          </div>
          <small>仅可登记只读接口；POST 也不能产生业务写入。</small>
          <HistoryJsonField field={`${name}.query`} label="查询参数与模板" kind="string-map" value={operation.query ?? EMPTY_MAP} onInvalid={onInvalid} onChange={value => setOperation(name, { ...operation, query: value as Record<string, string> })} hint="按服务器合同填入时间、游标、limit、snapshotRevision 等参数。" />
          {operation.method === 'POST' && <HistoryJsonField field={`${name}.body`} label="只读请求体" value={operation.body ?? EMPTY_MAP} onInvalid={onInvalid} onChange={body => setOperation(name, { ...operation, body })} />}
          <details><summary>响应字段映射</summary>
            <div className="history-settings-grid">{HTTP_PATHS.map(([key, label]) => <label key={key} className="history-settings-field"><span>{label}</span><input placeholder="/data/field" value={String(operation.mapping[key] ?? '')} onChange={event => setOperation(name, { ...operation, mapping: { ...operation.mapping, [key]: event.target.value } })} /></label>)}</div>
            <HistoryJsonField field={`${name}.fieldMap`} label="业务字段映射（规范字段指针 → 来源字段指针）" kind="string-map" value={operation.mapping.fieldMap ?? EMPTY_MAP} onInvalid={onInvalid} onChange={value => setOperation(name, { ...operation, mapping: { ...operation.mapping, fieldMap: value as Record<string, string> } })} hint="不执行 JavaScript，也不补造缺失的货物、库位或基线事实。" />
          </details>
        </>}
      </fieldset>;
    })}
    <details><summary>请求预算</summary><div className="history-settings-grid">
      {([['timeoutMs', '单请求超时（ms）', 10000], ['totalTimeoutMs', '总时限（ms）', 30000], ['maxResponseBytes', '响应字节上限', 1048576], ['maxPages', '分页上限', 100], ['maxItems', '记录上限', 10000]] as const).map(([key, label, defaultValue]) => <label className="history-settings-field" key={key}><span>{label}</span><input type="number" min={1} value={Number.isFinite(config.limits?.[key] ?? defaultValue) ? (config.limits?.[key] ?? defaultValue) : ''} onChange={event => onChange({ ...config, limits: { ...config.limits, [key]: event.currentTarget.valueAsNumber } })} /></label>)}
    </div><small>这是请求预算，不会放宽服务器上限；超限不会被当成合法空结果。</small></details>
  </>;
}

export function HistoryCredentialFields({ kind, value, onChange, disabled }: { kind: HistorySourceKind; value: HistorySourceCredential; onChange: (value: HistorySourceCredential) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled}><legend>只写凭据</legend>
    <label className="history-settings-field"><span>认证方式</span><select value={value.type} onChange={event => {
      switch (event.target.value) {
        case 'mqtt': onChange({ type: 'mqtt', username: '', password: '' }); break;
        case 'bearer': onChange({ type: 'bearer', token: '' }); break;
        case 'header': onChange({ type: 'header', name: '', value: '' }); break;
        default: onChange({ type: 'none' });
      }
    }}><option value="none">无认证</option>{kind === 'mqtt' ? <option value="mqtt">MQTT 用户名 / 密码</option> : <><option value="bearer">Bearer Token</option><option value="header">认证 Header</option></>}</select></label>
    {value.type === 'mqtt' && <div className="history-settings-grid"><label className="history-settings-field"><span>用户名</span><input autoComplete="off" value={value.username} onChange={event => onChange({ ...value, username: event.target.value })} /></label><label className="history-settings-field"><span>密码</span><input type="password" autoComplete="new-password" value={value.password} onChange={event => onChange({ ...value, password: event.target.value })} /></label></div>}
    {value.type === 'bearer' && <label className="history-settings-field"><span>Token</span><input type="password" autoComplete="new-password" value={value.token} onChange={event => onChange({ ...value, token: event.target.value })} /></label>}
    {value.type === 'header' && <div className="history-settings-grid"><label className="history-settings-field"><span>Header 名称</span><input autoComplete="off" value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} /></label><label className="history-settings-field"><span>Header 值</span><input type="password" autoComplete="new-password" value={value.value} onChange={event => onChange({ ...value, value: event.target.value })} /></label></div>}
    <small>仅提交给服务器凭据托管域；不回显，不写入场景、示例或发布包。</small>
  </fieldset>;
}
