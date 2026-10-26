import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** 显式加载output隔离包；禁止回退项目/全局依赖或联网安装。 */
export async function loadPhase2MeshoptToolchain(root, productDecoder) {
  const packageRoot = path.join(path.resolve(root), 'node_modules', 'meshoptimizer');
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false);
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'meshoptimizer'); assert.equal(metadata.version, '0.23.0');
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const encoderFile = path.join(packageRoot, 'meshopt_encoder.js'), decoderFile = path.join(packageRoot, 'meshopt_decoder.js');
  const encoderSource = await readFile(encoderFile, 'utf8');
  assert.match(encoderSource, /meshopt_encodeVertexVersion\(0\)/, 'EXT必须使用vertex bitstream v0。');
  const encoder = require(encoderFile), decoder = require(decoderFile);
  const source = await readFile(productDecoder, 'utf8');
  assert.match(source, /Built from meshoptimizer 0\.20/);
  // 产品脚本没有ESM导出；只在隔离VM中加载原文件，不改写产品decoder或切换全局配置。
  const module = { exports: {} }, context = vm.createContext({ module, exports: module.exports, WebAssembly, console });
  new vm.Script(source, { filename: productDecoder }).runInContext(context, { timeout: 10000 });
  const product = module.exports;
  await Promise.all([encoder.ready, decoder.ready, product.ready]);
  assert.ok(encoder.supported && decoder.supported && product.supported);
  return { encoder, decoders: [{ name: 'meshoptimizer@0.23.0', decoder }, { name: 'product-meshoptimizer@0.20', decoder: product }],
    files: { encoder: { path: encoderFile, sha256: sha(Buffer.from(encoderSource)) },
      decoder: { path: decoderFile, sha256: sha(await readFile(decoderFile)) },
      productDecoder: { path: path.resolve(productDecoder), sha256: sha(Buffer.from(source)) } } };
}
