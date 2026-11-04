import { useEffect, useState } from 'react';
import type { HistorySourceKind } from '../../../electron/shared/historyServiceContract';
import type { HistoryHttpSourceConfig, HistoryMqttSourceConfig, HistorySourceConfig } from '../../../electron/shared/historySourceConfig';
import { parseDeviceTelemetryMessage } from '../../runtime/mqtt/deviceTelemetry';
import { applyHistoryMqttFieldMap, compileHistoryMqttFieldMap } from '../../runtime/history/mqttFieldMap';

function pointer(root: unknown, path: string): unknown {
  if (path === '') return root;
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new Error('映射须使用 RFC6901 JSON Pointer，例如 /data/deviceId。');
  let current = root;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('映射含不安全的属性。');
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('样本包含非有限数值，不能作为有效状态展示。');
  if (depth > 8) return '[超过展示层数]';
  if (Array.isArray(value)) return value.slice(0, 5).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60).map(([key, item]) => [key,
    /password|secret|token|authorization|api.?key|cookie/iu.test(key) ? '[已隐藏]' : redact(item, depth + 1),
  ]));
  return typeof value === 'string' && value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

function mappedValue(root: unknown, path: string): unknown {
  const value = pointer(root, path);
  return value === undefined ? '[路径不存在]' : redact(value);
}

/** 离线样本只验证字段可读取性；不写遥测 Store、不访问上游，也不证明业务完整性。 */
export function HistorySourceSamplePreview({ kind, config, disabled }: { kind: HistorySourceKind; config: HistorySourceConfig; disabled: boolean }) {
  const [sample, setSample] = useState('');
  const [topic, setTopic] = useState('');
  const [operation, setOperation] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setResult(null); setError(null); }, [config, kind, sample, topic, operation]);
  if (kind === 'platform') return null;
  const http = kind === 'http' || kind === 'external-http' ? config as HistoryHttpSourceConfig : null;
  const operations = Object.keys(http?.operations ?? {});
  const selectedOperation = operations.includes(operation) ? operation : operations[0] ?? '';
  return <details><summary>离线脱敏样本映射检查</summary>
    <p className="history-settings-note">仅粘贴已脱敏样本。最多读取前 5 条记录，结果不上传、不写入场景，也不等于服务端预检通过。</p>
    {kind === 'mqtt' && <label className="history-settings-field"><span>样例 Topic</span><input value={topic} onChange={event => setTopic(event.target.value)} placeholder="填入真实 topic 结构，勿使用订阅通配符" /></label>}
    {http && <label className="history-settings-field"><span>检查接口映射</span><select value={selectedOperation} onChange={event => setOperation(event.target.value)}>{operations.map(name => <option key={name}>{name}</option>)}</select></label>}
    <label className="history-settings-field"><span>脱敏 JSON 样本</span><textarea rows={5} maxLength={65_536} spellCheck={false} value={sample} onChange={event => setSample(event.target.value)} /></label>
    <button type="button" disabled={disabled || !sample.trim()} onClick={() => {
      setError(null); setResult(null);
      try {
        if (new TextEncoder().encode(sample).byteLength > 131_072) throw new Error('样本超过 128 KiB 字节预算。');
        const parsed: unknown = JSON.parse(sample);
        if (kind === 'mqtt') {
          const mqtt = config as HistoryMqttSourceConfig;
          const fieldMap = compileHistoryMqttFieldMap(mqtt.parser.fieldMap);
          if (mqtt.parser.adapter === 'epv-v1') {
            if (!topic || topic.includes('+') || topic.includes('#')) throw new Error('EPV 样本需要具体 Topic，不能使用订阅通配符。');
            const frame = parseDeviceTelemetryMessage(topic, sample, { kind: 'epv', sourceId: mqtt.logicalSourceId });
            if (!frame) throw new Error('样本未生成设备快照，请检查 EPV 数据与 Topic。');
            if (frame.sequence !== null && frame.sequence !== undefined && !Number.isSafeInteger(frame.sequence)) throw new Error('样本序号超过安全整数范围，应在历史来源合同中使用字符串序号。');
            setResult(JSON.stringify(redact({ sourceId: frame.sourceId, deviceType: frame.deviceType, assetCode: frame.assetCode, fields: applyHistoryMqttFieldMap(frame.fields, fieldMap, mqtt.parser.mode), sourceTimestamp: frame.sourceTimestamp, sequence: frame.sequence }), null, 2));
          } else {
            const records = mqtt.parser.recordsPath ? pointer(parsed, mqtt.parser.recordsPath) : parsed;
            const rows = Array.isArray(records) ? records.slice(0, 5) : [records];
            const keys = ['deviceTypePath', 'deviceIdPath', 'statePath', 'eventTimePath', 'sequencePath', 'epochPath', 'eventIdPath'] as const;
            const previews = rows.map(row => {
              const mappings = Object.fromEntries(keys.map(key => [key, mqtt.parser[key] === undefined ? '[未映射]' : mappedValue(row, mqtt.parser[key]!)]));
              if (mqtt.parser.statePath === undefined) return { mappings, fields: '[未映射状态对象]' };
              const fields = pointer(row, mqtt.parser.statePath);
              if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('状态路径必须指向 JSON 对象。');
              return { mappings, fields: redact(applyHistoryMqttFieldMap(fields as Record<string, unknown>, fieldMap, mqtt.parser.mode)) };
            });
            setResult(JSON.stringify(previews, null, 2));
          }
        } else if (http) {
          const mapping = http.operations[selectedOperation as keyof typeof http.operations]?.mapping;
          if (!mapping) throw new Error('请先启用并配置要检查的接口。');
          const values = Object.entries(mapping).filter(([key, value]) => key !== 'fieldMap' && typeof value === 'string')
            .map(([field, path]) => ({ field, path, value: mappedValue(parsed, path as string) }));
          const records = selectedOperation === 'baseline' ? (mapping.statePath === undefined ? undefined : pointer(parsed, mapping.statePath))
            : selectedOperation === 'events' ? (mapping.itemsPath === undefined ? undefined : pointer(parsed, mapping.itemsPath))
              : mapping.itemsPath !== undefined ? pointer(parsed, mapping.itemsPath)
                : mapping.statePath !== undefined ? pointer(parsed, mapping.statePath) : parsed;
          const rows = selectedOperation === 'coverage' ? [] : Array.isArray(records) ? records.slice(0, 5) : [records];
          const fields = rows.map(row => Object.entries(mapping.fieldMap ?? {}).map(([target, path]) => ({ target, path, value: mappedValue(row, path) })));
          setResult(JSON.stringify({ responseMappings: values, recordMappings: fields }, null, 2));
        }
      } catch (reason) { setError(reason instanceof SyntaxError ? '样本不是合法 JSON。' : reason instanceof Error ? reason.message : '样本无法解析。'); }
    }}>仅在本机解析样本</button>
    {error && <p role="alert" className="history-settings-error">{error}</p>}
    {result && <pre className="history-settings-sample" aria-label="脱敏映射结果">{result}</pre>}
  </details>;
}
