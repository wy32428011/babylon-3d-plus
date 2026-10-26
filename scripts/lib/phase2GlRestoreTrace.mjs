/** 显式诊断模式专用：getError会消费队列，结果绝不能作为功能PASS或性能样本。 */
export function installPhase2GlRestoreTrace({ gl, frame, expectedLoss, maxRecords = 16, exposeGlobal = false, nativeOnly = true } = {}) {
  gl ??= globalThis.__phase2MipsProbe?.getContext?.();
  frame ??= () => globalThis.__phase2MipsProbe?.getFrameId?.() ?? null;
  expectedLoss ??= () => globalThis.__phase2MipsProbe?.isExpectedLossActive?.() === true;
  if (!gl || typeof gl.getError !== 'function' || typeof gl.isContextLost !== 'function') throw new Error('GL restore trace requires an owned actual context');
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 128) throw new Error('GL restore trace maxRecords must be 1..128');
  const originalGetError = gl.getError, originalIsContextLost = gl.isContextLost, changes = [], records = [], conflicts = [], skipped = [];
  let inside = false, stopped = false, calls = 0, expectedCodes = 0, dropped = 0;
  const small = value => { if (value === null) return { type: 'null' }; const type = typeof value;
    if (type === 'string') return { type, length: value.length };
    if (type === 'number' || type === 'boolean' || type === 'undefined') return { type, value: type === 'number' && !Number.isFinite(value) ? String(value) : value };
    if (ArrayBuffer.isView(value)) return { type: value.constructor?.name ?? 'ArrayBufferView', byteLength: value.byteLength, length: value.length ?? null };
    if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
    return { type: value.constructor?.name ?? type };
  };
  const record = (method, args, code, error, stage = 'after-native') => {
    const contextLost = Reflect.apply(originalIsContextLost, gl, []), explicitLoss = expectedLoss();
    if (!error && code === 0x9242 && contextLost && explicitLoss) { expectedCodes++; return; }
    if (!error && code === 0) return;
    const value = { method, stage, code, frame: frame(), contextLost, explicitExpectedLoss: explicitLoss, callIndex: calls,
      args: args.slice(0, 12).map(small), argumentCount: args.length,
      ...(error ? { exception: { name: error.name ?? typeof error, message: String(error.message ?? error).slice(0, 160) } } : {}),
      stack: String(new Error().stack ?? '').split('\n').slice(2, 8).map(line => line.slice(0, 220)) };
    if (records.length < maxRecords) records.push(value); else dropped++;
  };
  const describe = () => ({ status: 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS', stopped, calls, nativeOnly, expectedContextLostCodes: expectedCodes,
    firstUnexpected: records[0] ?? null, records: records.map(value => ({ ...value })), droppedRecords: dropped, restoredDescriptorConflicts: [...conflicts],
    wrappedMethods: changes.map(value => value.name), skippedMethods: [...skipped], errorQueueConsumed: true });
  const stop = () => { if (stopped) return describe(); stopped = true;
    for (const entry of [...changes].reverse()) { const current = Object.getOwnPropertyDescriptor(gl, entry.name);
      if (current?.value !== entry.wrapper) { conflicts.push({ method: entry.name, reason: 'own descriptor changed by another owner; preserved' }); continue; }
      try { if (entry.own) Object.defineProperty(gl, entry.name, entry.own); else if (!Reflect.deleteProperty(gl, entry.name)) throw new Error('delete failed'); }
      catch (error) { conflicts.push({ method: entry.name, reason: String(error.message ?? error).slice(0, 160) }); }
    }
    return describe();
  };
  const names = new Set();
  for (let prototype = gl; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) if (name !== 'constructor') names.add(name);
  }
  try {
    for (const name of names) {
      if (['getError', 'isContextLost'].includes(name)) continue;
      const original = gl[name]; if (typeof original !== 'function') continue;
      if (nativeOnly && !Function.prototype.toString.call(original).includes('[native code]')) { skipped.push(name); continue; }
      const own = Object.getOwnPropertyDescriptor(gl, name);
      if (own && (own.get || own.set || own.configurable === false && own.writable === false)) { skipped.push(name); continue; }
      const wrapper = function (...args) {
        if (inside || stopped) return Reflect.apply(original, this, args);
        inside = true; calls++; let result, nativeError, diagnosticError;
        try { result = Reflect.apply(original, this, args); } catch (error) { nativeError = error; }
        try { const code = Reflect.apply(originalGetError, gl, []); record(name, args, code, nativeError); }
        catch (error) { diagnosticError = error;
          // 保留getError自身exception身份；日志不可再调用getError重试。
          if (records.length < maxRecords) records.push({ method: name, stage: 'getError-threw', frame: frame(), exception: { name: error.name, message: String(error.message ?? error).slice(0, 160) } }); else dropped++;
        } finally { inside = false; }
        if (nativeError) throw nativeError; if (diagnosticError) throw diagnosticError; return result;
      };
      Object.defineProperty(gl, name, own ? { ...own, value: wrapper } : { value: wrapper, configurable: true, writable: true, enumerable: false });
      changes.push({ name, own, wrapper });
    }
    inside = true;
    try { record('<install>', [], Reflect.apply(originalGetError, gl, []), null, 'preexisting-at-install'); } finally { inside = false; }
  } catch (error) { stop(); throw error; }
  const control = { snapshot: describe, stop };
  if (exposeGlobal) { globalThis.__phase2GlRestoreTrace = control; return describe(); }
  return control;
}
