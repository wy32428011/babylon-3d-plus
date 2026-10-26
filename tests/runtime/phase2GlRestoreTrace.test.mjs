import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { installPhase2GlRestoreTrace } from '../../scripts/lib/phase2GlRestoreTrace.mjs';

function fixture() {
  const nativeFailure = new Error('original-native-failure'), getErrorFailure = new Error('original-getError-failure');
  let code = 0, lost = false, throwingGetError = false;
  const prototype = { drawArrays(...args) { if (args[0] === 'throw') throw nativeFailure; if (args[0] === 'bad') code = 1282; return args[0]; },
    bufferData() { code = 1281; return 19; } };
  const gl = Object.create(prototype);
  Object.defineProperty(gl, 'clear', { value: function () { code = 1280; return 7; }, configurable: true, enumerable: true, writable: true });
  gl.getError = function () { if (throwingGetError) throw getErrorFailure; const value = code; code = 0; return value; };
  gl.isContextLost = () => lost;
  return { gl, nativeFailure, getErrorFailure, setGetErrorThrow: value => { throwingGetError = value; }, setLost: value => { lost = value; }, setCode: value => { code = value; } };
}

test('installed SDK restore入口存在；纯JS合同保持return/throw、bounded非二进制日志与精确own descriptors', () => {
  assert.equal(typeof Engine.prototype._restoreEngineAfterContextLost, 'function');
  const f = fixture(), own = Object.getOwnPropertyDescriptor(f.gl, 'clear'), getError = f.gl.getError;
  const trace = installPhase2GlRestoreTrace({ gl: f.gl, nativeOnly: false, frame: () => 4, maxRecords: 2 });
  assert.equal(f.gl.drawArrays(42), 42); assert.equal(f.gl.clear(), 7); assert.equal(f.gl.bufferData(new Uint8Array(1024 * 1024)), 19);
  assert.throws(() => f.gl.drawArrays('throw'), error => error === f.nativeFailure);
  const result = trace.stop(); assert.equal(result.status, 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS'); assert.equal(result.firstUnexpected.code, 1280);
  assert.equal(result.records.length, 2); assert.equal(result.droppedRecords, 1); assert.equal(result.records[1].args[0].byteLength, 1024 * 1024);
  assert.ok(JSON.stringify(result).length < 5000); assert.deepEqual(Object.getOwnPropertyDescriptor(f.gl, 'clear'), own);
  assert.equal(Object.hasOwn(f.gl, 'drawArrays'), false); assert.equal(f.gl.getError, getError); trace.stop();
});

test('getError exception身份不吞、原native throw优先、不递归；expected loss只归本次明确token', () => {
  const f = fixture(); let expected = false;
  const trace = installPhase2GlRestoreTrace({ gl: f.gl, nativeOnly: false, expectedLoss: () => expected, frame: () => 7 });
  f.setGetErrorThrow(true); assert.throws(() => f.gl.drawArrays(9), error => error === f.getErrorFailure);
  assert.throws(() => f.gl.drawArrays('throw'), error => error === f.nativeFailure); f.setGetErrorThrow(false);
  f.setLost(true); expected = true; f.setCode(0x9242); assert.equal(f.gl.drawArrays(1), 1);
  expected = false; f.setCode(0x9242); f.gl.drawArrays(1);
  const result = trace.stop(); assert.equal(result.expectedContextLostCodes, 1); assert.ok(result.records.some(value => value.code === 0x9242 && !value.explicitExpectedLoss));
});

test('nativeOnly默认、self-contained与其他owner冲突保持；不修改prototype或其它context', () => {
  const f = fixture(), original = Object.getPrototypeOf(f.gl).drawArrays;
  const install = new Function('return (' + installPhase2GlRestoreTrace.toString() + ');')();
  const native = { getError: () => 0, isContextLost: () => false, max: Math.max };
  const actualNative = install({ gl: native }); assert.ok(actualNative.snapshot().wrappedMethods.includes('max')); assert.equal(native.max(2, 8), 8); actualNative.stop(); assert.equal(native.max, Math.max);
  const trace = install({ gl: f.gl, nativeOnly: false }), replacement = () => 'another owner'; f.gl.clear = replacement;
  assert.equal(trace.stop().restoredDescriptorConflicts.length, 1); assert.equal(f.gl.clear, replacement); assert.equal(Object.getPrototypeOf(f.gl).drawArrays, original);
});
