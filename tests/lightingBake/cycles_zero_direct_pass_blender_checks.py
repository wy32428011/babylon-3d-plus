"""B4 真实 Cycles 对照：完整像素/PNG零差异，保留自发光及未知节点回退。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.world = None
    for collection in [bpy.data.meshes, bpy.data.materials, bpy.data.worlds, bpy.data.images]:
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def setup(module, root, kind):
    clear_scene()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.seed = 20261025
    scene.cycles.use_animated_seed = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    material = {"baseColor": [0.8, 0.8, 0.8], "alpha": 1, "metallic": 0, "roughness": 0.8,
                "emissive": [0, 0, 0], "doubleSided": True}
    data = [
        {"name": "Floor", "positions": [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2],
         "normals": [0, 1, 0] * 4, "indices": [0, 2, 1, 0, 3, 2], "uvs": [0, 0, 1, 0, 1, 1, 0, 1],
         "worldMatrix": IDENTITY, "material": material},
        {"name": "Wall", "positions": [-2, 0, -2, 2, 0, -2, 2, 2, -2, -2, 2, -2],
         "normals": [0, 0, 1] * 4, "indices": [0, 1, 2, 0, 2, 3], "uvs": [0, 0, 1, 0, 1, 1, 0, 1],
         "worldMatrix": IDENTITY, "material": {**material, "baseColor": [0.9, 0.1, 0.1],
                                                   "emissive": [2, 0.2, 0] if kind == "emission" else [0, 0, 0]}},
    ]
    objects = [module.make_mesh(entry, root, index) for index, entry in enumerate(data)]
    environment = {"color": [0.3, 0.4, 0.5], "intensity": 0.3 if kind == "environment" else 0}
    lights = module.setup_lights({"environment": environment, "lights": [
        {"kind": "directional", "position": [0, 4, 0], "direction": [-0.4, -1, -0.2], "color": [1, 1, 1], "intensity": 2}
    ]}, root)
    if kind == "linked-emission":
        tree = objects[1].data.materials[0].node_tree
        rgb = tree.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (1, 0.2, 0, 1)
        tree.links.new(rgb.outputs[0], tree.nodes.get("Principled BSDF").inputs["Emission Color"])
    elif kind == "unknown-node":
        tree = objects[1].data.materials[0].node_tree
        group = bpy.data.node_groups.new("UnknownUnusedShader", "ShaderNodeTree")
        tree.nodes.new("ShaderNodeGroup").node_tree = group
    elif kind == "animated-strength":
        shader = objects[1].data.materials[0].node_tree.nodes.get("Principled BSDF")
        shader.inputs["Emission Strength"].driver_add("default_value").driver.expression = "1"
    pages = module.pack_atlases(objects, 256, 8, 16 * 1024 * 1024)
    assert len(pages) == 1
    bpy.context.view_layer.update()
    return objects, lights, pages[0]


def run(module, kind, output, name):
    objects, lights, page = setup(module, output, kind)
    can_skip = module.can_skip_zero_direct_pass(bpy.context.scene, lights) if hasattr(module, "can_skip_zero_direct_pass") else None
    original = module.bake_diffuse
    calls = []

    def timed():
        started = time.perf_counter()
        original()
        calls.append((time.perf_counter() - started) * 1000)

    module.bake_diffuse = timed
    before_images = len(bpy.data.images)
    started = time.perf_counter()
    try:
        pixels = module.bake_irradiance(page, lights, 256, "IrradianceOracle")
    finally:
        module.bake_diffuse = original
    elapsed = (time.perf_counter() - started) * 1000
    assert len(bpy.data.images) == before_images
    assert all(not light.hide_render for light in lights)
    assert bpy.context.scene.render.bake.use_pass_direct and not bpy.context.scene.render.bake.use_pass_indirect
    png = output / (name + ".png")
    dynamic_range = module.save_rgbm(pixels, 256, png)
    return {"canSkip": can_skip, "bakeCalls": len(calls), "callMs": calls, "elapsedMs": elapsed,
            "pixels": pixels, "pngSha256": hashlib.sha256(png.read_bytes()).hexdigest(),
            "rgbmRange": dynamic_range, "maxRgb": float(pixels.reshape(-1, 4)[:, :3].max())}


def public(result):
    return {key: value for key, value in result.items() if key != "pixels"}


def compare(reference, actual):
    different = int(np.count_nonzero(reference["pixels"].view(np.uint32) != actual["pixels"].view(np.uint32)))
    assert different == 0, f"B4 changed {different} float32 components"
    assert reference["pngSha256"] == actual["pngSha256"]
    assert reference["rgbmRange"] == actual["rgbmRange"]
    return {"components": int(reference["pixels"].size), "differentComponents": different,
            "pngShaEqual": True, "rgbmRangeEqual": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-script", type=Path, required=True)
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.output = args.output.resolve()
    args.baseline_script = args.baseline_script.resolve()
    args.bake_script = args.bake_script.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    baseline, candidate = load(args.baseline_script, "b4_baseline"), load(args.bake_script, "b4_candidate")
    report = {"status": "RUNNING", "blender": bpy.app.version_string, "device": "CPU", "samples": 16, "threads": 2,
              "blenderPath": bpy.app.binary_path,
              "sources": {"baselineSha256": hashlib.sha256(args.baseline_script.read_bytes()).hexdigest(),
                          "candidateSha256": hashlib.sha256(args.bake_script.read_bytes()).hexdigest(),
                          "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
              "scope": "controlled real Cycles small scene, no factory/GPU performance claim", "cases": []}
    try:
        for kind in ["zero", "environment", "emission", "linked-emission", "unknown-node", "animated-strength"]:
            old = run(baseline, kind, args.output, kind + "-baseline")
            new = run(candidate, kind, args.output, kind + "-candidate")
            comparison = compare(old, new)
            assert old["bakeCalls"] == 2
            assert new["canSkip"] is (kind == "zero")
            assert new["bakeCalls"] == (1 if kind == "zero" else 2)
            assert old["maxRgb"] > 0, "zero-output fixture cannot establish meaningful equality"
            report["cases"].append({"kind": kind, "baseline": public(old), "candidate": public(new), "comparison": comparison})
            (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        report["status"] = "PASS"
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = str(error)
        raise
    finally:
        (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("CYCLES_ZERO_DIRECT_PASS_REAL " + json.dumps(report))


if __name__ == "__main__":
    main()
