import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('B4只跳过证明为零的直射遍，保留未知/自发光回退及失败清理', () => {
  const result = spawnSync('python', ['tests/lightingBake/cycles_zero_direct_pass_checks.py'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CYCLES_ZERO_DIRECT_PASS_CONTRACT/);
});
