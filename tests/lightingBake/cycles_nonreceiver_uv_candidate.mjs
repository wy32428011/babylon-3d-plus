import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** 只生成output内的研究候选；不写产品Python，不启动Blender。 */
export async function freezeNonreceiverUvCandidate({ output, source = path.join(repository, 'electron/lighting-bake/cycles_bake.py') }) {
  output = path.resolve(output); source = path.resolve(source);
  const relative = path.relative(path.join(repository, 'output'), output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '候选只允许output专属新目录');
  const baseline = await fs.readFile(source), text = baseline.toString('utf8'), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const anchor = 'def make_mesh(data: dict, root: Path, index: int) -> Any:';
  assert.equal(text.split(anchor).length, 2, 'make_mesh锚点漂移，不猜测补丁位置');
  const old = ['    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02, area_weight=1.0,',
    '                             correct_aspect=False, scale_to_bounds=False)'].join(eol);
  assert.equal(text.split(old).length, 2, 'smart_project锚点漂移，不替换未知路径');
  const helper = `def can_skip_nonreceiver_lightmap_uv(data: dict) -> bool:
    """仅研究候选：非receiver且材质仅依赖完整显式SourceUV时，LightmapUV不被消费。"""
    if type(data) is not dict or data.get("receiver", True) is not False:
        return False
    positions = data.get("positions")
    if type(positions) not in (list, tuple, array) or not positions or len(positions) % 3:
        return False
    material = data.get("material")
    allowed = {"baseColor", "alpha", "alphaMode", "alphaCutoff", "useTextureAlpha", "useVertexAlpha", "meshVisibility",
               "metallic", "roughness", "emissive", "doubleSided", "invertNormalMapX", "invertNormalMapY", "textures"}
    if type(material) is not dict or set(material) - allowed:
        return False
    textures = material.get("textures", {})
    if type(textures) is not dict:
        return False
    for kind, entry in textures.items():
        if kind not in {"baseColor", "emissive", "metallicRoughness", "normal", "occlusion"} or type(entry) is not dict:
            return False
        coordinates = entry.get("coordinatesIndex")
        if type(coordinates) is not int or coordinates not in (0, 1):
            return False
        values = data.get("uvs2" if coordinates else "uvs")
        if type(values) not in (list, tuple, array) or len(values) != len(positions) // 3 * 2:
            return False
        if not all(type(value) in (int, float) and math.isfinite(value) for value in values):
            return False
    return True


`;
  let candidate = text.replace(anchor, helper.replaceAll('\n', eol) + anchor);
  candidate = candidate.replace(old, ['    if not can_skip_nonreceiver_lightmap_uv(data):',
    '        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02, area_weight=1.0,',
    '                                 correct_aspect=False, scale_to_bounds=False)'].join(eol));
  // 保留LightmapUV层、active/render标志、世界线性往返、EDIT/select_all/OBJECT及法线设置，仅跳算UV。
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  const oldFile = path.join(output, 'baseline-cycles_bake.py'), newFile = path.join(output, 'candidate-cycles_bake.py');
  await fs.writeFile(oldFile, baseline, { flag: 'wx' }); await fs.writeFile(newFile, candidate, { flag: 'wx' });
  assert.equal(sha(await fs.readFile(source)), sha(baseline), '冻结期间主Python发生变化，不能混用版本');
  const manifest = { status: 'FROZEN_CANDIDATE_NOT_VALIDATED_NOT_ADOPTED', generatedAt: new Date().toISOString(), source,
    baseline: { file: oldFile, sha256: sha(baseline) }, candidate: { file: newFile, sha256: sha(Buffer.from(candidate)) },
    change: 'guard only bpy.ops.uv.smart_project; keep all surrounding material/UV layers/mode-selection/geometry-roundtrip/normals code',
    fallback: 'receiver absent/true, unknown material/texture/layout, missing or non-finite requested source UV => original unwrap',
    requiredOracle: 'real Blender CPU fixed seed A/A and A/B; exact float32 PNG receiver geometry SourceUV/TBN/probes; no synthetic claim of real-business acceptance',
    originalProductWritten: false, blenderExecuted: false };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--output');
  freezeNonreceiverUvCandidate({ output: process.argv[index + 1] }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
