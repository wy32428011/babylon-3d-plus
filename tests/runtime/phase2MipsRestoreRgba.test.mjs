import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// 仅加载真实pure函数，避免默认CPU fixture依赖未生成的dist或触发Playwright导入。
const source = readFileSync(new URL('../helpers/phase2MipsGiAcceptance.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('actual-helper.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'compareMipsRestoreRgba');
const protocolNode = tree.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(tree) === 'mipsContextRestoreProtocol');
assert.ok(declaration && protocolNode); const protocol = new Function('return (' + protocolNode.initializer.getText(tree) + ');')();
const compare = new Function('Buffer', 'mipsContextRestoreProtocol', 'return (' + declaration.getText(tree).replace(/^export\s+/, '') + ');')(Buffer, protocol);
const frame = (bytes = [1, 2, 3, 255]) => ({ width: 1, height: 1, rgba: Buffer.from(bytes), sha256: 'deliberately-same-declared-hash' });

test('Viewer只等待250ms状态UI追上已正常runtime，保留真实GI错误和2秒上限',async()=>{
  const node=tree.statements.find(item=>ts.isFunctionDeclaration(item)&&item.name?.text==='waitForMipsViewerStatusUi');assert.ok(node);
  const state={ready:true,runtimeFound:true,runtimeError:null,maps:[{ready:true}],hudErrors:['historical status pending UI poll']};
  const wait=new Function('window','return ('+node.getText(tree).replace(/^export\s+/,'')+');')({__phase2MipsProbe:{snapshot:()=>state}});
  const deadlines=[];
  await wait({waitForFunction:async(predicate,_arg,options)=>{deadlines.push(options.timeout);
    if(options.timeout===180000){assert.equal(predicate(),true);return;}
    assert.equal(predicate(),false);state.hudErrors=[];assert.equal(predicate(),true);
  }});
  assert.deepEqual(deadlines,[180000,2000]);
  state.runtimeError='actual invalid geometry';
  await assert.rejects(wait({waitForFunction:async(predicate)=>predicate()}),/actual invalid geometry/);
  state.runtimeError=null;state.hudErrors=['persistent warning'];
  await assert.rejects(wait({waitForFunction:async(predicate,_arg,options)=>{if(options.timeout===2000){assert.equal(predicate(),false);throw new Error('bounded UI timeout');}predicate();}}),/bounded UI timeout/);
});

test('用户批准的独立协议：自然AA仍exact；恢复仅RGB≤1/alpha exact；Mip仍exact', () => {
  assert.deepEqual(protocol, { id: 'phase2-b9-context-restore-rgb1-alpha0-v1', naturalAaMaxRgbaDelta: 0,
    contextRestoreMaxRgbDelta: 1, contextRestoreMaxAlphaDelta: 0, mipBytesMustBeExact: true });
  const value = compare({ before0: frame(), before1: frame(), after: frame() });
  assert.equal(value.status, 'PASS_RESTORE_RGBA_IDENTICAL'); assert.equal(value.aaStable, true); assert.equal(value.restoreIdentical, true); assert.equal(value.functionalPass, true);
  assert.deepEqual({ maxRgbDelta: value.maxRgbDelta, maxAlphaDelta: value.maxAlphaDelta, differentPixels: value.differentPixels,
    alphaDifferentPixels: value.alphaDifferentPixels, rgbOverOnePixels: value.rgbOverOnePixels }, { maxRgbDelta: 0, maxAlphaDelta: 0, differentPixels: 0, alphaDifferentPixels: 0, rgbOverOnePixels: 0 });
});
test('完整Node bytes按新restore协议：RGB1通过，RGB2或alpha1失败，假SHA不能替代比较', () => {
  const one = compare({ before0: frame(), before1: frame(), after: frame([2, 3, 2, 255]) });
  assert.equal(one.status, 'PASS_RESTORE_RGBA_WITHIN_RGB1_ALPHA0'); assert.equal(one.functionalPass, true); assert.equal(one.restoreIdentical, false);
  assert.equal(one.maxRgbDelta, 1); assert.equal(one.differentPixels, 1); assert.equal(one.alphaDifferentPixels, 0); assert.equal(one.rgbOverOnePixels, 0);
  const two = compare({ before0: frame(), before1: frame(), after: frame([3, 2, 3, 255]) });
  assert.equal(two.status, 'FAIL_RESTORE_RGBA_MISMATCH'); assert.equal(two.functionalPass, false); assert.equal(two.rgbOverOnePixels, 1); assert.equal(two.maxRgbDelta, 2);
  const alpha = compare({ before0: frame(), before1: frame(), after: frame([1, 2, 3, 254]) });
  assert.equal(alpha.status, 'FAIL_RESTORE_RGBA_MISMATCH'); assert.equal(alpha.functionalPass, false); assert.equal(alpha.alphaDifferentPixels, 1); assert.equal(alpha.maxAlphaDelta, 1);
});
test('自然AA不得套RGB1容差，任意1byte不稳仍INCONCLUSIVE', () => {
  assert.equal(compare({ before0: frame(), before1: frame([2, 2, 3, 255]), after: frame() }).status, 'INCONCLUSIVE_NATURAL_AA_UNSTABLE');
  assert.equal(compare({ before0: frame(), before1: frame([1, 2, 3, 254]), after: frame() }).functionalPass, false);
});
test('空/不完整buffer不能伪PASS；尺寸变化同样是完整画面不一致', () => {
  assert.throws(() => compare({ before0: frame(), before1: frame(), after: { width: 2, height: 2, rgba: Buffer.alloc(4) } }), /完整RGBA/);
  const resized = compare({ before0: frame(), before1: frame(), after: { width: 2, height: 1, rgba: Buffer.alloc(8) } }); assert.equal(resized.status, 'FAIL_RESTORE_RGBA_MISMATCH');
});
test('完整buffer末pixel仍参与统计，不能只核首pixel或声明SHA', () => {
  const before = { width: 2, height: 1, rgba: Buffer.from([1, 2, 3, 255, 10, 20, 30, 255]), sha256: 'same-claim' };
  const after = { ...before, rgba: Buffer.from([1, 2, 3, 255, 12, 20, 30, 254]) }, value = compare({ before0: before, before1: before, after });
  assert.equal(value.functionalPass, false); assert.equal(value.differentPixels, 1); assert.equal(value.rgbOverOnePixels, 1); assert.equal(value.alphaDifferentPixels, 1);
});
