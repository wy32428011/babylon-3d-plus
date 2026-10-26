import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('非receiver UV候选纯谓词保守回退，不导入Blender', { skip: !process.env.PHASE2_NONRECEIVER_UV_CANDIDATE
  && '须显式提供已冻结output候选；不修改/隐式生成主Python' }, () => {
  const result = spawnSync('python', ['tests/lightingBake/cycles_nonreceiver_uv_checks.py', '--candidate', process.env.PHASE2_NONRECEIVER_UV_CANDIDATE], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.match(result.stdout, /CYCLES_NONRECEIVER_UV_CONTRACT/);
});
