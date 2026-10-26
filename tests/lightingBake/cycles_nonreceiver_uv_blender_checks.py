"""研究候选真实Cycles oracle；只读冻结脚本，只写独立output，不改用户Blender/原资产。"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
sys.dont_write_bytecode = True

import bpy
from mathutils import Vector
import numpy as np

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
ROOT = Path(__file__).resolve().parents[2]
CASES = ["opaque", "uv1-normal-nonuniform", "mask-texture-vertex-alpha", "blend-uv2-negative-scale",
         "emission-uv2", "vertex-color", "missing-source-uv-fallback", "unknown-texture-fallback", "default-receiver"]
FALLBACK = {"missing-source-uv-fallback", "unknown-texture-fallback", "default-receiver"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clear(module):
    module.TEXTURE_IMAGES.clear()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.world = None
    for collection in [bpy.data.meshes, bpy.data.materials, bpy.data.worlds, bpy.data.images]:
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def textures(root):
    root.mkdir()
    for name, normal in [("color.png", False), ("normal.png", True)]:
        image = bpy.data.images.new("OracleSource", width=16, height=16, alpha=True)
        values = np.empty((16, 16, 4), dtype=np.float32)
        for y in range(16):
            for x in range(16):
                if normal:
                    values[y, x] = [.25 if x < 8 else .75, .3 if y < 8 else .7, .95, 1]
                else:
                    values[y, x] = [.9 if x < 8 else .1, .2 if y < 8 else .8, .4, .2 if (x // 4 + y // 4) % 2 else 1]
        image.pixels.foreach_set(values.reshape(-1))
        image.file_format = "PNG"
        image.filepath_raw = str(root / name)
        image.save()
        bpy.data.images.remove(image)


def texture(name, coordinates=0):
    return {"file": name, "coordinatesIndex": coordinates, "colorSpace": "linear", "uScale": .9, "vScale": .65,
            "uOffset": .13, "vOffset": .07, "wAng": .15, "level": .7 if name == "normal.png" else 1,
            "invertY": True, "wrapU": 1, "wrapV": 1}


def fixture(kind):
    material = {"baseColor": [.8, .7, .6], "alpha": 1, "alphaMode": "opaque", "metallic": 0,
                "roughness": .8, "emissive": [0, 0, 0], "doubleSided": True,
                "invertNormalMapX": True, "invertNormalMapY": False}
    common = {"worldMatrix": IDENTITY, "uvs": [0, 0, 1, 0, 1, 1, 0, 1]}
    floor = {**common, "key": "receiver/floor", "entityId": "receiver", "nodeKey": "floor", "name": "Floor", "receiver": True,
             "positions": [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2], "normals": [0, 1, 0] * 4,
             "indices": [0, 2, 1, 0, 3, 2], "material": copy.deepcopy(material)}
    wall = {**common, "key": "occluder/wall", "entityId": "occluder", "nodeKey": "wall", "name": "Wall", "receiver": False,
            "positions": [-1, 0, -.6, 1, 0, -.6, 1, 2, -.6, -1, 2, -.6], "normals": [0, 0, 1] * 4,
            "indices": [0, 1, 2, 0, 2, 3], "material": copy.deepcopy(material),
            "uvs2": [.1, .2, .1, .8, .9, .8, .9, .2]}
    if kind == "uv1-normal-nonuniform":
        wall["material"]["textures"] = {"baseColor": texture("color.png"), "normal": texture("normal.png")}
        wall["worldMatrix"] = [1.2, 0, 0, 0, 0, 1.4, 0, 0, 0, 0, .7, 0, .1, 0, .2, 1]
    elif kind == "mask-texture-vertex-alpha":
        wall["colors"] = [1, .2, .1, .2, .2, 1, .1, 1, .2, .1, 1, .4, 1, 1, .2, 1]
        wall["material"].update(alphaMode="mask", alphaCutoff=.5, useTextureAlpha=True, useVertexAlpha=True,
                                textures={"baseColor": texture("color.png")})
    elif kind == "blend-uv2-negative-scale":
        wall["worldMatrix"] = [-1.1, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, .8, 0, 0, 0, .1, 1]
        wall["material"].update(alpha=.7, alphaMode="blend", useTextureAlpha=True,
                                textures={"baseColor": texture("color.png", 1), "normal": texture("normal.png", 1)})
    elif kind == "emission-uv2":
        wall["material"].update(emissive=[2, .5, .2], textures={"emissive": texture("color.png", 1)})
    elif kind == "vertex-color":
        wall["colors"] = [1, .2, .1, 1, .2, 1, .1, 1, .2, .1, 1, 1, 1, 1, .2, 1]
    elif kind == "missing-source-uv-fallback":
        wall.pop("uvs2")
        wall["material"]["textures"] = {"baseColor": texture("color.png", 1)}
    elif kind == "unknown-texture-fallback":
        wall["material"]["textures"] = {"vendorUnknown": texture("color.png")}
    elif kind == "default-receiver":
        wall.pop("receiver")
    return [floor, wall]


class Proxy:
    def __init__(self, target, overrides):
        self.target, self.overrides = target, overrides

    def __getattr__(self, key):
        return self.overrides[key] if key in self.overrides else getattr(self.target, key)


def source_proof(obj):
    mesh = obj.data
    # 独立计算显式SourceUV层的真实TBN，不借用导出器期望结果；只在功能oracle里执行。
    layers = {}
    for layer in mesh.uv_layers:
        if layer.name.startswith("SourceUV"):
            layers[layer.name] = np.asarray([tuple(value.uv) for value in layer.data], dtype=np.float32).tobytes()
    tbn = {}
    for node in obj.data.materials[0].node_tree.nodes:
        if node.bl_idname == "ShaderNodeNormalMap" and node.uv_map in mesh.uv_layers:
            mesh.calc_tangents(uvmap=node.uv_map)
            tbn[node.uv_map] = np.asarray([(*loop.tangent, loop.bitangent_sign) for loop in mesh.loops], dtype=np.float32).tobytes()
    arrays = {"vertices": np.asarray([tuple(vertex.co) for vertex in mesh.vertices], dtype=np.float32).tobytes(),
              "worldMatrix": np.asarray([tuple(row) for row in obj.matrix_world], dtype=np.float32).tobytes(),
              "loopIndices": np.asarray([loop.vertex_index for loop in mesh.loops], dtype=np.uint32).tobytes(),
              "cornerNormals": np.asarray([tuple(value.vector) for value in mesh.corner_normals], dtype=np.float32).tobytes(),
              **{"uv:" + key: value for key, value in layers.items()}, **{"tbn:" + key: value for key, value in tbn.items()}}
    return {"sha256": {key: digest(value) for key, value in arrays.items()},
            "uvLayers": [{"name": layer.name, "activeRender": layer.active_render} for layer in mesh.uv_layers],
            "activeUv": mesh.uv_layers.active.name,
            "explicitBindings": sorted((node.bl_idname, node.uv_map) for node in obj.data.materials[0].node_tree.nodes
                                       if node.bl_idname in {"ShaderNodeUVMap", "ShaderNodeNormalMap"})}


def numeric_payload(value):
    if isinstance(value, dict):
        return [number for key in sorted(value) for number in numeric_payload(value[key])]
    if isinstance(value, list):
        return [number for item in value for number in numeric_payload(item)]
    return [value] if type(value) in (int, float) else []


def run(module, kind, output, assets):
    output.mkdir(parents=True)
    clear(module)
    for file in assets.iterdir():
        shutil.copyfile(file, output / file.name)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = 16
    scene.cycles.use_denoising = False; scene.cycles.seed = 20261025; scene.cycles.use_animated_seed = False
    scene.cycles.max_bounces = 4; scene.cycles.diffuse_bounces = 2
    scene.render.threads_mode = "FIXED"; scene.render.threads = 2
    sources = fixture(kind)
    calls = [0]

    def smart_project(*args, **kwargs):
        calls[0] += 1
        return bpy.ops.uv.smart_project(*args, **kwargs)

    real_bpy = module.bpy
    module.bpy = Proxy(bpy, {"ops": Proxy(bpy.ops, {"uv": Proxy(bpy.ops.uv, {"smart_project": smart_project})})})
    try:
        objects = [module.make_mesh(source, output, index) for index, source in enumerate(sources)]
        source_geometry = [source_proof(obj) for obj in objects]
        receivers = [obj for index, obj in enumerate(objects) if sources[index].get("receiver", True)]
        pages = module.pack_atlases(receivers, 256, 8, 16 * 1024 ** 2)
        assert len(pages) == 1
        lights = module.setup_lights({"environment": {"color": [.3, .4, .5], "intensity": .3}, "lights": [
            {"kind": "directional", "position": [0, 4, 0], "direction": [-.4, -1, -.2], "color": [1, 1, 1], "intensity": 2}]}, output)
        bpy.context.view_layer.update()
        pixels = module.bake_irradiance(pages[0], lights, 256, "NonreceiverUvOracle")
        assert np.isfinite(pixels).all() and np.any(pixels.reshape(-1, 4)[:, :3] > 0)
        image = output / "irradiance.png"; dynamic_range = module.save_rgbm(pixels, 256, image)
        receiver_geometry = [module.collect_export_geometry(obj, sources[obj["input_index"]]) for obj in receivers]
        module.bake_probes(objects, lights, 16, output, [module.vector([0, .4, .4]), module.vector([.6, .7, .2])])
        probes = json.loads((output / "probes.json").read_text(encoding="utf-8"))
        probe_floats = np.asarray(numeric_payload(probes), dtype=np.float32)
        assert np.isfinite(probe_floats).all() and np.any(probe_floats != 0)
        pixels.tofile(output / "irradiance-f32.bin"); probe_floats.tofile(output / "probe-f32.bin")
        (output / "receiver-geometry.json").write_text(json.dumps(receiver_geometry, allow_nan=False, separators=(",", ":")), encoding="utf-8")
        result = {"smartProjectCalls": calls[0], "sourceProof": source_geometry,
                  "irradianceFloat32Sha256": digest(pixels.tobytes()), "irradianceComponents": int(pixels.size),
                  "pngSha256": digest(image.read_bytes()), "rgbmRange": dynamic_range,
                  "receiverGeometrySha256": digest((output / "receiver-geometry.json").read_bytes()),
                  "probeFloat32Sha256": digest(probe_floats.tobytes()), "probeFloat32Components": int(probe_floats.size),
                  "probeJsonSha256": digest((output / "probes.json").read_bytes()), "probeCount": len(probes["probes"]),
                  "probeImageSize": module.PROBE_IMAGE_SIZE}
        (output / "proof.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result
    finally:
        module.bpy = real_bpy


def compare(reference, actual):
    for field in ["sourceProof", "irradianceFloat32Sha256", "pngSha256", "rgbmRange", "receiverGeometrySha256",
                  "probeFloat32Sha256", "probeJsonSha256", "probeCount", "probeImageSize"]:
        assert reference[field] == actual[field], "真实oracle不相等：" + field
    return {"exactFloat32": True, "exactPng": True, "exactReceiverGeometry": True,
            "exactSourceUvGeometryAndTbn": True, "exactProbeJsonAndFloat32": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-script", type=Path, required=True)
    parser.add_argument("--candidate-script", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.output = args.output.resolve()
    boundary = (ROOT / "output").resolve()
    assert args.output != boundary and boundary in args.output.parents, "oracle只允许output全新专属目录"
    args.output.mkdir(parents=True)
    baseline_bytes, candidate_bytes = args.baseline_script.read_bytes(), args.candidate_script.read_bytes()
    baseline, candidate = load(args.baseline_script.resolve(), "nonreceiver_baseline"), load(args.candidate_script.resolve(), "nonreceiver_candidate")
    assets = args.output / "assets"; textures(assets)
    report = {"status": "RUNNING", "scope": "controlled real Blender CPU alpha/material/source-UV/TBN/geometry/probe equivalence; not real-business GI acceptance or acceleration",
              "blender": bpy.app.version_string, "blenderPath": bpy.app.binary_path, "samples": 16, "threads": 2,
              "sources": {"baselineSha256": digest(baseline_bytes), "candidateSha256": digest(candidate_bytes), "harnessSha256": digest(Path(__file__).read_bytes())}, "cases": []}
    try:
        for kind in CASES:
            old = run(baseline, kind, args.output / kind / "baseline-AA0", assets)
            repeat = run(baseline, kind, args.output / kind / "baseline-AA1", assets)
            new = run(candidate, kind, args.output / kind / "candidate", assets)
            aa, ab = compare(old, repeat), compare(old, new)
            assert old["smartProjectCalls"] == 2
            assert new["smartProjectCalls"] == (2 if kind in FALLBACK else 1)
            report["cases"].append({"kind": kind, "baseline": old, "repeat": repeat, "candidate": new, "AA": aa, "AB": ab})
            (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        report["status"] = "PASS"
    except Exception as error:
        report.update(status="FAIL", error=str(error)); raise
    finally:
        report["frozenSourcesUnchanged"] = digest(args.baseline_script.read_bytes()) == digest(baseline_bytes) and digest(args.candidate_script.read_bytes()) == digest(candidate_bytes)
        (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("CYCLES_NONRECEIVER_UV_REAL " + json.dumps({"status": report["status"], "cases": len(report["cases"])}))


if __name__ == "__main__":
    main()
