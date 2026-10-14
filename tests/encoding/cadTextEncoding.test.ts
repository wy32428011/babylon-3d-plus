import assert from 'node:assert/strict';
import test from 'node:test';
import { createCadDxfStreamDecoder, decodeCadDxfBytes } from '../../src/editor/cad/cadTextEncoding.ts';

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

test('AC1021 及以上使用 UTF-8，即使 HEADER 仍声明 ANSI_936', () => {
  for (const version of ['AC1021', 'AC1027', 'AC1032']) {
    const text = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\n' + version + '\n9\n$DWGCODEPAGE\n3\nANSI_936\n0\nENDSEC\n中文图层\n';
    assert.equal(decodeCadDxfBytes(new TextEncoder().encode(text)), text);
  }
});

test('旧版 AC1018 的 ANSI_936 保留 GB18030 兼容', () => {
  const bytes = concatenate(new TextEncoder().encode('9\n$ACADVER\n1\nAC1018\n9\n$DWGCODEPAGE\n3\nANSI_936\n'), Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.match(decodeCadDxfBytes(bytes), /中文$/u);
});

test('流式 UTF-8 保留跨字节块中文和 CRLF，小文件 flush 正确', () => {
  const text = '9\r\n$ACADVER\r\n1\r\nAC1032\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_936\r\n中文图层\r\n';
  const bytes = new TextEncoder().encode(text);
  const decoder = createCadDxfStreamDecoder();
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 1) output += decoder.decode(bytes.subarray(offset, offset + 1));
  output += decoder.decode(undefined, true);
  assert.equal(output, text);
});

test('流式 ANSI_936 保留跨字节块中文', () => {
  const bytes = concatenate(new TextEncoder().encode('9\n$DWGCODEPAGE\n3\nANSI_936\n'), Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]));
  const decoder = createCadDxfStreamDecoder();
  let output = '';
  for (const byte of bytes) output += decoder.decode(Uint8Array.of(byte));
  output += decoder.decode(undefined, true);
  assert.match(output, /中文$/u);
});

test('流式探测仅缓存首 16 KiB，后续块直接解码且正确 flush UTF-8', () => {
  const header = '9\n$ACADVER\n1\nAC1032\n9\n$DWGCODEPAGE\n3\nANSI_936\n';
  const text = header + 'x'.repeat(16 * 1024 - header.length - 1) + '中文\n0\nEOF\n';
  const bytes = new TextEncoder().encode(text);
  const decoder = createCadDxfStreamDecoder();
  const output = decoder.decode(bytes.subarray(0, 16 * 1024)) + decoder.decode(bytes.subarray(16 * 1024), true);
  assert.equal(output, text);
});

test('流式尾部损坏字节严格报错，且完成后拒绝继续解码', () => {
  const invalidUtf8 = createCadDxfStreamDecoder();
  invalidUtf8.decode(new TextEncoder().encode('9\n$ACADVER\n1\nAC1032\n'));
  invalidUtf8.decode(Uint8Array.of(0xe4));
  assert.throws(() => invalidUtf8.decode(undefined, true), /CAD\/DXF 文件不是有效的 UTF-8 文本/u);
  const invalidGb = createCadDxfStreamDecoder();
  invalidGb.decode(new TextEncoder().encode('9\n$DWGCODEPAGE\n3\nANSI_936\n'));
  assert.throws(() => invalidGb.decode(Uint8Array.of(0xd6), true), /GB18030/u);
  const completed = createCadDxfStreamDecoder();
  assert.equal(completed.decode(new TextEncoder().encode('0\nEOF\n'), true), '0\nEOF\n');
  assert.throws(() => completed.decode(Uint8Array.of(0x30)), /已结束/u);
});
