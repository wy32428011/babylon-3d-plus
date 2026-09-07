import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const CLI_VERSION = '4.4.2';
const require = createRequire(import.meta.url);

export function parseOptions(args) {
  const positional = [];
  let mode = 'dedup';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--mode') mode = args[++index];
    else if (argument.startsWith('--mode=')) mode = argument.slice('--mode='.length);
    else if (argument.startsWith('-')) throw new Error(`未知参数：${argument}`);
    else positional.push(argument);
  }
  assert.ok(['dedup', 'ktx2'].includes(mode), '--mode 必须为 dedup 或 ktx2。');
  assert.equal(positional.length, 2, '用法：node scripts/optimize-environment-glb.mjs <input.glb> <output.glb> [--mode dedup|ktx2]');
  const [input, output] = positional.map((item) => path.resolve(item));
  assert.ok(/\.glb$/i.test(input) && /\.glb$/i.test(output), '输入和输出必须为 .glb 文件。');
  assert.notEqual(input.toLowerCase(), output.toLowerCase(), '输入输出不能是同一路径。');
  return { input, output, mode, reportPath: `${output}.report.json` };
}

/** 拒绝任何已存在的输出，包括符号链接和目录；CLI 永远只写专属暂存目录。 */
export async function validatePaths(options) {
  const input = await realpath(options.input);
  assert.ok((await lstat(input)).isFile(), '输入必须是普通 GLB 文件。');
  for (const destination of [options.output, options.reportPath]) {
    try { await lstat(destination); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`拒绝覆盖已存在的文件或目录：${destination}`);
  }
  assert.notEqual(input.toLowerCase(), options.output.toLowerCase(), '输入输出不能指向同一文件。');
}

export function conversionArguments(mode, input, output) {
  assert.ok(['dedup', 'ktx2'].includes(mode), '转换模式必须为 dedup 或 ktx2。');
  if (mode === 'dedup') {
    return ['dedup', input, output, '--accessors', 'false', '--materials', 'false', '--meshes', 'false', '--skins', 'false', '--textures', 'true'];
  }
  // 不传 --slots 过滤器，覆盖 baseColor、normal、metallicRoughness 及其它材质贴图。
  // 不开启 RDO；保持 quality 2，通过较低 Zstd 级别控制离线处理成本。
  return ['uastc', input, output, '--level', '2', '--zstd', '5', '--jobs', '2'];
}

/** KHR_texture_basisu 要求4倍数尺寸；不适合的图片保持原字节，禁止 CLI 隐式重采样。 */
export function createKtxEncodingPlan(textures) {
  const names = textures.map((texture) => texture.getName());
  const foldedNames = names.map((name) => name.toLowerCase());
  // CLI 的 glob 使用 nocase/contains；大小写或子串歧义也必须用互不重叠的临时名规避。
  const needsAliases = new Set(foldedNames).size !== names.length
    || names.some((name) => !name || /[*?\[\]{}(),!|\\]/.test(name))
    || foldedNames.some((name, index) => foldedNames.some((other, otherIndex) => index !== otherIndex && other.includes(name)));
  const selected = [];
  const skipped = [];
  for (let index = 0; index < textures.length; index += 1) {
    const texture = textures[index];
    const size = texture.getSize();
    const name = texture.getName();
    const codingName = needsAliases ? `__ktx_texture_${index}__` : name;
    const mimeType = texture.getMimeType();
    const reason = !['image/png', 'image/jpeg'].includes(mimeType) ? 'already-compressed-or-unsupported-format'
      : !size ? 'unknown-dimensions' : size[0] % 4 || size[1] % 4 ? 'dimensions-not-multiple-of-four' : null;
    const entry = { index, name, codingName, size, sha256: digest(texture.getImage() ?? new Uint8Array()) };
    if (reason) skipped.push({ ...entry, reason });
    else selected.push(entry);
  }
  assert.ok(selected.length, '没有尺寸可保持不变的 KTX2 编码目标。');
  return { selected, skipped, needsAliases, pattern: selected.length === 1 ? selected[0].codingName : `{${selected.map((entry) => entry.codingName).join(',')}}` };
}

/** 只复用已安装或已缓存的固定版本；不隐式联网下载工具。 */
export async function resolveToolchain(environment = process.env) {
  const explicit = environment.ZENDING_GLTF_TRANSFORM_CLI;
  const candidates = [];
  if (explicit) {
    const resolved = path.resolve(explicit);
    candidates.push((await lstat(resolved)).isDirectory() ? path.join(resolved, 'bin', 'cli.js') : resolved);
  } else {
    try { candidates.push(require.resolve('@gltf-transform/cli')); } catch { /* 本地未安装时检查现有缓存。 */ }
    const cacheRoots = new Set([
      environment.npm_config_cache,
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'npm-cache'),
      path.join(homedir(), '.npm'),
    ].filter(Boolean));
    for (const cache of cacheRoots) {
      const npxRoot = path.join(cache, '_npx');
      const entries = await readdir(npxRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        candidates.push(path.join(npxRoot, entry.name, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js'));
      }
    }
  }
  for (const candidate of candidates) {
    const packageRoot = path.resolve(path.dirname(candidate), '..');
    try {
      const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      if (metadata.name !== '@gltf-transform/cli' || metadata.version !== CLI_VERSION) {
        if (explicit) throw new Error(`必须使用 @gltf-transform/cli ${CLI_VERSION}，当前为 ${metadata.name}@${metadata.version}。`);
        continue;
      }
      const cliPath = path.join(packageRoot, 'bin', 'cli.js');
      await lstat(cliPath);
      return { packageRoot, cliPath, version: metadata.version };
    } catch (error) {
      if (error.code === 'ENOENT' && !explicit) continue;
      throw error;
    }
  }
  throw new Error(`找不到已安装的 @gltf-transform/cli ${CLI_VERSION}。请显式准备该版本，并用 ZENDING_GLTF_TRANSFORM_CLI 指向其 bin/cli.js 或包目录。`);
}

async function createIO(toolchain) {
  const toolRequire = createRequire(path.join(toolchain.packageRoot, 'package.json'));
  const load = (name) => import(pathToFileURL(toolRequire.resolve(name)).href);
  const [core, extensions, dracoModule, meshopt] = await Promise.all([
    load('@gltf-transform/core'), load('@gltf-transform/extensions'), load('draco3dgltf'), load('meshoptimizer'),
  ]);
  const draco = dracoModule.default ?? dracoModule;
  await Promise.all([meshopt.MeshoptDecoder.ready, meshopt.MeshoptEncoder.ready]);
  const io = new core.NodeIO().registerExtensions(extensions.ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco.createDecoderModule(), 'draco3d.encoder': await draco.createEncoderModule(),
    'meshopt.decoder': meshopt.MeshoptDecoder, 'meshopt.encoder': meshopt.MeshoptEncoder,
  });
  return { io, supportedExtensions: new Set(extensions.ALL_EXTENSIONS.map((extension) => extension.EXTENSION_NAME)) };
}

function glbJson(bytes) {
  assert.ok(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67, '输入不是 GLB。');
  assert.equal(bytes.readUInt32LE(4), 2, '只支持 glTF 2.0 GLB。');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB 文件长度不匹配。');
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB 首块必须为 JSON。');
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}

/** 单文件输入禁止外部资源，避免 CLI 读入网络或在输出旁生成意外的附属文件。 */
export function validateDocumentJson(json, supportedExtensions) {
  for (const resource of [...(json.images ?? []), ...(json.buffers ?? [])]) {
    assert.ok(!resource.uri || resource.uri.startsWith('data:'), '只支持资源内嵌的 GLB；请先封装外部图片或 buffer。');
  }
  for (const extension of json.extensionsUsed ?? []) {
    assert.ok(supportedExtensions.has(extension), `不支持的扩展 ${extension}，拒绝可能丢失语义的转换。`);
  }
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function without(object, keys) { return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key))); }

/** 在相同 NodeIO 规范化后比较语义，忽略存储偏移与图片别名，保留所有模型及材质参数。 */
export async function semanticSnapshot(io, document, mode) {
  const root = document.getRoot();
  const json = (await io.writeJSON(document)).json;
  const images = root.listTextures().map((texture) => ({
    size: texture.getSize(), extras: texture.getExtras(),
    ...(mode === 'dedup' ? { mimeType: texture.getMimeType(), sha256: digest(texture.getImage() ?? new Uint8Array()) } : {}),
  }));
  const textureBindings = (json.textures ?? []).map((texture) => {
    const source = texture.source ?? texture.extensions?.KHR_texture_basisu?.source;
    return {
      ...without(texture, ['source', 'sampler', 'extensions', 'name']),
      image: images[source], sampler: json.samplers?.[texture.sampler] ?? {},
      extensions: without(texture.extensions ?? {}, ['KHR_texture_basisu']),
    };
  });
  const replaceTextureBindings = (value, key = '') => {
    if (Array.isArray(value)) return value.map((item) => replaceTextureBindings(item));
    if (!value || typeof value !== 'object') return value;
    const mapped = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceTextureBindings(item, name)]));
    if (/Texture$/.test(key) && typeof value.index === 'number') mapped.index = textureBindings[value.index];
    return mapped;
  };
  const normalized = replaceTextureBindings(without(json, ['buffers', 'bufferViews', 'images', 'textures', 'samplers', 'accessors']));
  normalized.extensionsUsed = (normalized.extensionsUsed ?? []).filter((name) => name !== 'KHR_texture_basisu');
  normalized.extensionsRequired = (normalized.extensionsRequired ?? []).filter((name) => name !== 'KHR_texture_basisu');
  const accessorSignatures = new Map(root.listAccessors().map((accessor) => {
    const array = accessor.getArray();
    return [accessor, {
      name: accessor.getName(), extras: accessor.getExtras(), type: accessor.getType(),
      componentType: accessor.getComponentType(), normalized: accessor.getNormalized(), count: accessor.getCount(),
      sha256: array ? digest(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)) : null,
    }];
  }));
  // CLI 会按存储用途重排 accessor；必须比较每个实际引用的数据，不能只排序哈希集合。
  const attributes = (primitive) => Object.fromEntries(primitive.listSemantics().map((semantic) => [
    semantic, accessorSignatures.get(primitive.getAttribute(semantic)),
  ]));
  root.listMeshes().forEach((mesh, meshIndex) => mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
    const definition = normalized.meshes[meshIndex].primitives[primitiveIndex];
    definition.attributes = attributes(primitive);
    if (primitive.getIndices()) definition.indices = accessorSignatures.get(primitive.getIndices());
    if (primitive.listTargets().length) definition.targets = primitive.listTargets().map(attributes);
  }));
  root.listSkins().forEach((skin, index) => {
    if (skin.getInverseBindMatrices()) normalized.skins[index].inverseBindMatrices = accessorSignatures.get(skin.getInverseBindMatrices());
  });
  root.listAnimations().forEach((animation, index) => animation.listSamplers().forEach((sampler, samplerIndex) => {
    const definition = normalized.animations[index].samplers[samplerIndex];
    definition.input = accessorSignatures.get(sampler.getInput());
    definition.output = accessorSignatures.get(sampler.getOutput());
  }));
  root.listNodes().forEach((node, index) => {
    const instancing = node.getExtension('EXT_mesh_gpu_instancing');
    if (instancing) normalized.nodes[index].extensions.EXT_mesh_gpu_instancing.attributes = attributes(instancing);
  });
  normalized.accessors = [...accessorSignatures.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  // 编码器可重写压缩块 offsets，但不能改变解码后的顶点、索引或动画数据。
  for (const mesh of normalized.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    if (primitive.extensions?.KHR_draco_mesh_compression) {
      primitive.extensions = without(primitive.extensions, ['KHR_draco_mesh_compression']);
      if (!Object.keys(primitive.extensions).length) delete primitive.extensions;
    }
  }
  return normalized;
}

export function assertSemanticsUnchanged(before, after) {
  try { assert.deepEqual(after, before); }
  catch {
    const firstDifference = (left, right, location = 'scene') => {
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return location;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (!isDeepStrictEqual(left[key], right[key])) return firstDifference(left[key], right[key], `${location}.${key}`);
      }
      return location;
    };
    throw new Error(`转换改变了几何数据、模型结构、动画或材质纹理参数（首个差异 ${firstDifference(before, after)}），拒绝生成输出；请保留原资产。`);
  }
}

function assetStatistics(bytes, document) {
  const textures = document.getRoot().listTextures();
  let totalPixels = 0;
  let imagesWithUnknownDimensions = 0;
  for (const texture of textures) {
    const size = texture.getSize();
    if (size) totalPixels += size[0] * size[1];
    else imagesWithUnknownDimensions += 1;
  }
  return { bytes: bytes.length, sha256: digest(bytes), imageCount: textures.length, totalPixels, imagesWithUnknownDimensions };
}

async function runCommand(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    // 参数独立传递，禁止 shell=true，路径中的空格或 shell 元字符不作为命令执行。
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (capture) {
      const append = (chunk) => { output = (output + chunk.toString()).slice(-8_192); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
    }
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`环境资产工具失败，退出码 ${code}：${output}`)));
  });
}

export async function optimizeEnvironment(options, environment = process.env) {
  await validatePaths(options);
  const startedAt = performance.now();
  const toolchain = await resolveToolchain(environment);
  if (options.mode === 'ktx2') {
    const version = await runCommand('ktx', ['--version'], true).catch((error) => {
      throw new Error(`ktx2 模式需要预先安装 KTX-Software >=4.3.0 并加入 PATH：${error.message}`);
    });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
    assert.ok(match && (Number(match[1]) > 4 || Number(match[1]) === 4 && Number(match[2]) >= 3), 'ktx2 模式要求 KTX-Software >=4.3.0。');
  }
  const { io, supportedExtensions } = await createIO(toolchain);
  const beforeBytes = await readFile(options.input);
  validateDocumentJson(glbJson(beforeBytes), supportedExtensions);
  const beforeDocument = await io.readBinary(beforeBytes);
  const beforeSnapshot = await semanticSnapshot(io, beforeDocument, options.mode);
  await mkdir(path.dirname(options.output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(options.output), '.environment-optimize-'));
  const stagedOutput = path.join(staging, 'converted.glb');
  try {
    let cliInput = options.input;
    const ktxPlan = options.mode === 'ktx2' ? createKtxEncodingPlan(beforeDocument.getRoot().listTextures()) : null;
    if (ktxPlan?.needsAliases) {
      // 别名只用于临时筛选；输出在语义验收前恢复每张原始图片名称。
      const aliasDocument = await io.readBinary(beforeBytes);
      aliasDocument.getRoot().listTextures().forEach((texture, index) => texture.setName(`__ktx_texture_${index}__`).setURI(''));
      cliInput = path.join(staging, 'encoding-input.glb');
      await io.write(cliInput, aliasDocument);
    }
    const cliArguments = conversionArguments(options.mode, cliInput, stagedOutput);
    if (ktxPlan) cliArguments.push('--pattern', ktxPlan.pattern);
    await runCommand(process.execPath, [toolchain.cliPath, ...cliArguments]);
    let afterBytes = await readFile(stagedOutput);
    validateDocumentJson(glbJson(afterBytes), supportedExtensions);
    let afterDocument = await io.readBinary(afterBytes);
    if (ktxPlan) {
      const encodedTextures = new Map(afterDocument.getRoot().listTextures().map((texture) => [texture.getName(), texture]));
      for (const entry of ktxPlan.selected) {
        assert.equal(encodedTextures.get(entry.codingName)?.getMimeType(), 'image/ktx2', `图片未成功编码：${entry.name}`);
      }
      for (const entry of ktxPlan.skipped) {
        assert.equal(digest(encodedTextures.get(entry.codingName)?.getImage() ?? new Uint8Array()), entry.sha256, `保留图片被意外改写：${entry.name}`);
      }
      if (ktxPlan.needsAliases) {
        for (const entry of [...ktxPlan.selected, ...ktxPlan.skipped]) encodedTextures.get(entry.codingName).setName(entry.name);
        afterBytes = await io.writeBinary(afterDocument);
        await writeFile(stagedOutput, afterBytes);
        afterDocument = await io.readBinary(afterBytes);
      }
    }
    assertSemanticsUnchanged(beforeSnapshot, await semanticSnapshot(io, afterDocument, options.mode));
    assert.equal(digest(await readFile(options.input)), digest(beforeBytes), '转换期间输入文件发生改变，拒绝发布转换副本。');
    const report = {
      status: 'PASS', generatedAt: new Date().toISOString(), mode: options.mode,
      tool: `@gltf-transform/cli@${CLI_VERSION}`, input: options.input, output: options.output,
      before: assetStatistics(beforeBytes, beforeDocument), after: assetStatistics(afterBytes, afterDocument),
      durationMs: performance.now() - startedAt,
      semanticValidation: 'normalized-nodeio-structure-material-texture-bindings-and-exact-decoded-accessor-sha256',
      imagePolicy: options.mode === 'dedup' ? 'exact-image-bytes-preserved' : 'lossy-uastc-all-material-texture-slots; visual-acceptance-required',
      ...(ktxPlan ? { ktx2: { quality: 2, rdo: false, zstd: 5, jobs: 2, encodedImageCount: ktxPlan.selected.length, pixelResampling: false,
        skippedImages: ktxPlan.skipped.map(({ name, size, reason }) => ({ name, size, reason })) } } : {}),
      sourceUnchanged: true,
    };
    // 排他创建防止检查到写入之间出现新文件时被覆盖。
    await copyFile(stagedOutput, options.output, constants.COPYFILE_EXCL);
    await writeFile(options.reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' }).catch((error) => {
      throw new Error(`优化副本已创建，但报告创建失败；不会覆盖任何已有报告：${options.reportPath}；${error.message}`);
    });
    console.log(JSON.stringify({ status: report.status, mode: report.mode, before: report.before, after: report.after, reportPath: options.reportPath }));
    return report;
  } finally {
    const relative = path.relative(path.dirname(options.output), staging);
    assert.ok(relative.startsWith('.environment-optimize-') && !relative.includes(path.sep), '暂存目录超出清理范围。');
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  optimizeEnvironment(parseOptions(process.argv.slice(2))).catch((error) => {
    console.error('[optimize-environment-glb] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
