import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCadDxfBytes } from '../../src/editor/cad/cadTextEncoding.ts';

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

test('CAD 主线程与 Worker 共用 ANSI_936 解码并保留中文图层名', () => {
  const ascii = new TextEncoder();
  const bytes = concatenate(
    ascii.encode('0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_936\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n2\n'),
    Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]),
    ascii.encode('\n0\nENDSEC\n0\nEOF\n'),
  );

  assert.match(decodeCadDxfBytes(bytes), /中文/u);
});

test('未声明 ANSI_936 的损坏 UTF-8 CAD 明确失败而不是生成替换字符', () => {
  const bytes = concatenate(
    new TextEncoder().encode('0\nSECTION\n2\nHEADER\n0\nENDSEC\n'),
    Uint8Array.from([0xc3, 0x28]),
  );

  assert.throws(() => decodeCadDxfBytes(bytes), /CAD\/DXF 文件不是有效的 UTF-8 文本/u);
});
