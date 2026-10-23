import type { AbstractEngine, DataBuffer, Geometry } from '@babylonjs/core';

type GeometryListener = Geometry['onGeometryUpdated'];
type GeometryUpdateState = { previous: GeometryListener; dispatcher: GeometryListener; listeners: Set<GeometryListener> };
const updates = new WeakMap<Geometry, GeometryUpdateState>();
type GeometryDelegate = { readonly previous: GeometryListener; trusted: boolean };
const geometryDelegates = new WeakMap<Geometry, WeakMap<NonNullable<GeometryListener>, GeometryDelegate>>();

/** 仅供内部包装创建时登记其捕获的固定前驱；不调用、不替换或改写任何回调。 */
export function registerGeometryUpdateDelegate(geometry: Geometry, callback: GeometryListener, previous: GeometryListener): void {
  if (typeof callback !== 'function') return;
  let delegates = geometryDelegates.get(geometry);
  if (!delegates) { delegates = new WeakMap(); geometryDelegates.set(geometry, delegates); }
  const existing = delegates.get(callback);
  if (existing) {
    // 同一函数不能被重新解释为另一条边；冲突后永久保守失效。
    if (existing.previous !== previous) existing.trusted = false;
  } else delegates.set(callback, { previous, trusted: true });
}

function reachesGeometryUpdateDelegate(geometry: Geometry, expected: GeometryListener): boolean {
  let current = geometry.onGeometryUpdated;
  if (current === expected) return true;
  const delegates = geometryDelegates.get(geometry), visited = new Set<GeometryListener>();
  while (typeof current === 'function') {
    if (current === expected) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const delegate = delegates?.get(current);
    if (!delegate?.trusted) return false;
    current = delegate.previous;
  }
  return false;
}

/**
 * 光照分类与动静合批共享Geometry唯一通知入口，避免已知订阅者互相覆盖。
 * 只认可同Geometry显式登记的内部delegate链；外部未知包装保持失效。
 * 最后释放只还原自己直接拥有的入口，弱边保留给仍在外层回调中的真实前驱。
 */
export function subscribeLightingGeometryUpdates(geometry: Geometry, listener: GeometryListener): { isCurrent: () => boolean; release: () => void } {
  let state = updates.get(geometry);
  if (!state) {
    const previous = geometry.onGeometryUpdated;
    const created: GeometryUpdateState = { previous, dispatcher: previous, listeners: new Set() };
    created.dispatcher = function (this: Geometry, updated, kind) {
      try { previous?.call(this, updated, kind); }
      finally {
        // 一次通知可能使controller同步释放自己，不能继续调用已经解除的订阅。
        for (const current of [...created.listeners]) if (created.listeners.has(current)) current.call(this, updated, kind);
      }
    };
    registerGeometryUpdateDelegate(geometry, created.dispatcher, previous);
    geometry.onGeometryUpdated = created.dispatcher;
    updates.set(geometry, created); state = created;
  }
  const shared = state;
  const entry: GeometryListener = function (this: Geometry, updated, kind) { listener.call(this, updated, kind); };
  shared.listeners.add(entry);
  let released = false;
  return {
    isCurrent: () => !released && reachesGeometryUpdateDelegate(geometry, shared.dispatcher),
    release: () => {
      if (released) return; released = true;
      shared.listeners.delete(entry);
      if (shared.listeners.size) return;
      if (geometry.onGeometryUpdated === shared.dispatcher) geometry.onGeometryUpdated = shared.previous;
      if (updates.get(geometry) === shared) updates.delete(geometry);
    },
  };
}

type UploadMethod = 'updateDynamicVertexBuffer' | 'updateDynamicIndexBuffer' | 'updateArrayBuffer'
  | 'updateAndBindInstancesBuffer' | 'updateUniformBuffer';
type UploadFunction = (this: AbstractEngine, ...args: unknown[]) => unknown;
type UploadEntry = { key: UploadMethod; previous: UploadFunction; wrapper: UploadFunction; descriptor?: PropertyDescriptor };
type UploadState = { entries: UploadEntry[]; buffers: Map<DataBuffer, Set<() => void>>; subscriptions: number;
  bindArrayBuffer: UploadFunction };
const uploads = new WeakMap<AbstractEngine, UploadState>();
const UPLOAD_METHODS: readonly UploadMethod[] = ['updateDynamicVertexBuffer', 'updateDynamicIndexBuffer',
  'updateArrayBuffer', 'updateAndBindInstancesBuffer', 'updateUniformBuffer'];

/** 本机WebGL/NullEngine的公开上传均经过这些入口；WebGPU storage/compute可绕过CPU上传，保守保留源。 */
export function canObserveLightingBufferUploads(engine: AbstractEngine): boolean {
  return !engine.isWebGPU && ['Engine', 'ThinEngine', 'NullEngine'].includes(engine.getClassName())
    && Array.isArray(Reflect.get(engine, '_currentBoundBuffer'))
    && typeof Reflect.get(engine, 'bindArrayBuffer') === 'function'
    && UPLOAD_METHODS.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(engine, key);
      return typeof Reflect.get(engine, key) === 'function'
        && (descriptor ? descriptor.configurable === true : Object.isExtensible(engine));
    });
}

/**
 * 只按DataBuffer对象查找已接管源，上传之前通知所有共享宿主；无关buffer只做一次Map查询。
 * 不修改源缓冲/updatable/CPU数据。最后订阅释放仅还原仍由本模块持有的入口。
 */
export function subscribeLightingBufferUploads(engine: AbstractEngine, buffers: readonly DataBuffer[], listener: () => void): {
  isCurrent: () => boolean; release: () => void;
} {
  if (!canObserveLightingBufferUploads(engine)) return { isCurrent: () => false, release: () => undefined };
  let state = uploads.get(engine);
  if (!state) {
    const created: UploadState = { entries: [], buffers: new Map(), subscriptions: 0,
      bindArrayBuffer: Reflect.get(engine, 'bindArrayBuffer') as UploadFunction };
    for (const key of UPLOAD_METHODS) {
      const previous = Reflect.get(engine, key) as UploadFunction;
      const wrapper: UploadFunction = function (this: AbstractEngine, ...args) {
        if (this === engine && (key !== 'updateAndBindInstancesBuffer' || args[1] != null)) {
          const buffer = key === 'updateArrayBuffer' ? Reflect.get(engine, '_currentBoundBuffer')[34962] as unknown : args[0];
          const affected = created.buffers.get(buffer as DataBuffer);
          // 首个回退会同步释放其它订阅；这次上传开始时的全部受影响宿主仍须退出，不能漏掉共享源。
          if (affected) for (const notify of [...affected]) notify();
          // 回退会同步触发宿主光照刷新，可能改变GL绑定；隐式上传必须恢复调用者原来绑定的源。
          if (affected && key === 'updateArrayBuffer' && Reflect.get(engine, '_currentBoundBuffer')[34962] !== buffer) {
            created.bindArrayBuffer.call(this, buffer);
          }
        }
        return previous.apply(this, args);
      };
      created.entries.push({ key, previous, wrapper, descriptor: Object.getOwnPropertyDescriptor(engine, key) });
    }
    try {
      for (const entry of created.entries) Object.defineProperty(engine, entry.key, { configurable: true,
        writable: true, value: entry.wrapper, enumerable: entry.descriptor?.enumerable ?? false });
    } catch (error) {
      for (const entry of created.entries) if (Reflect.get(engine, entry.key) === entry.wrapper) {
        if (entry.descriptor) Object.defineProperty(engine, entry.key, entry.descriptor);
        else Reflect.deleteProperty(engine, entry.key);
      }
      throw error;
    }
    uploads.set(engine, created); state = created;
  }
  const shared = state, unique = [...new Set(buffers)];
  // 同一个listener可注册多个独立订阅，不能因Set去重让其中一次release解除别人的监听。
  const notify = () => listener();
  for (const buffer of unique) {
    const listeners = shared.buffers.get(buffer) ?? new Set<() => void>();
    listeners.add(notify); shared.buffers.set(buffer, listeners);
  }
  shared.subscriptions++;
  let released = false;
  return {
    isCurrent: () => !released && Reflect.get(engine, 'bindArrayBuffer') === shared.bindArrayBuffer
      && shared.entries.every(entry => Reflect.get(engine, entry.key) === entry.wrapper),
    release: () => {
      if (released) return; released = true;
      for (const buffer of unique) {
        const listeners = shared.buffers.get(buffer); listeners?.delete(notify);
        if (!listeners?.size) shared.buffers.delete(buffer);
      }
      if (--shared.subscriptions > 0) return;
      for (const entry of shared.entries) if (Reflect.get(engine, entry.key) === entry.wrapper) {
        if (entry.descriptor) Object.defineProperty(engine, entry.key, entry.descriptor);
        else Reflect.deleteProperty(engine, entry.key);
      }
      if (uploads.get(engine) === shared) uploads.delete(engine);
    },
  };
}
