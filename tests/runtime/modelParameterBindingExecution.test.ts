import assert from 'node:assert/strict';
import test from 'node:test';
import { executeModelParameterBindings } from '../../src/runtime/babylon/modelParameterBindingExecution.ts';

test('旧参数不兼容的绑定或规则只记日志，不阻断其他绑定与后续规则', () => {
  const binding = (name: string) => ({ target: { kind: 'mesh' as const, name }, property: 'visible' as const, value: true });
  const applied: string[] = [];
  const logs: string[] = [];
  executeModelParameterBindings({ schema: 'babylon-editor.model-parameters', version: 1, parameters: [],
    bindings: [binding('bad'), binding('ok')],
    rules: [{ when: 'bad-rule', set: [binding('skipped')] }, { when: true, set: [binding('bad'), binding('rule-ok')] }],
  }, {
    apply: item => { if (item.target.name === 'bad') throw Error('incompatible saved value'); applied.push(item.target.name); },
    evaluateRule: expression => { if (expression === 'bad-rule') throw Error('old condition'); return true; },
    report: message => logs.push(message),
  });
  assert.deepEqual(applied, ['ok', 'rule-ok']);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /bad.visible.*保留模型和参数值/);
});
