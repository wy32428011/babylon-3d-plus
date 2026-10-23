"""用真实七表面输入逐三角面比较共享图集与单对象基准，不能以整张图非黑代替验收。"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cycles_bake", ROOT / "electron" / "lighting-bake" / "cycles_bake.py")
BAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BAKE)


def read_centers(pixels, obj, size: int) -> list[list[float]]:
    uv = obj.data.uv_layers["LightmapUV"]
    values = []
    for face in obj.data.polygons:
        coordinates = [uv.data[index].uv for index in face.loop_indices]
        u = sum(value.x for value in coordinates) / len(coordinates)
        v = sum(value.y for value in coordinates) / len(coordinates)
        x = max(0, min(size - 1, int(u * size)))
        y = max(0, min(size - 1, int(v * size)))
        offset = (y * size + x) * 4
        values.append(list(pixels[offset:offset + 3]))
    return values


def validate_exported_source(obj, source: dict, output: Path) -> None:
    BAKE.export_geometry(obj, source, output)
    exported = json.loads(output.read_text(encoding="utf-8"))
    assert exported["indices"] == list(range(len(source["indices"])))
    for name, width in (("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4)):
        if name not in source:
            continue
        expected = [component for index in source["indices"] for component in source[name][index * width:index * width + width]]
        assert exported[name] == expected, f"{source['name']} 的 {name} 或原三角形绕序发生变化"


def orientation_checks(template: dict, output: Path) -> list[dict]:
    results = []
    for name, reverse, mirror in (("babylon-left-handed", False, False), ("right-handed-input", True, False), ("mirrored-world", False, True)):
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        source = copy.deepcopy(template)
        source["name"] = name
        source["worldMatrix"] = [-1 if mirror else 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        if reverse:
            for index in range(0, len(source["indices"]), 3):
                source["indices"][index + 1], source["indices"][index + 2] = source["indices"][index + 2], source["indices"][index + 1]
        if "uvs" not in source:
            source["uvs"] = [value for index in range(len(source["positions"]) // 3) for value in (index % 2, index // 2 % 2)]
        source["uvs2"] = [value * 0.5 + 0.1 for value in source["uvs"]]
        source["colors"] = [0.7, 0.8, 0.9, 1] * (len(source["positions"]) // 3)
        source["tangents"] = []
        for index in range(0, len(source["normals"]), 3):
            normal = Vector(source["normals"][index:index + 3])
            reference = Vector((1, 0, 0)) if abs(normal.x) < 0.9 else Vector((0, 1, 0))
            tangent = normal.cross(reference).normalized()
            source["tangents"].extend([*tangent, -1 if index % 6 else 1])
        obj = BAKE.make_mesh(source, output, 0)
        for face in obj.data.polygons:
            normal = sum((obj.data.corner_normals[index].vector for index in face.loop_indices), Vector()).normalized()
            assert face.normal.dot(normal) > 0.99, f"{name} 在 Cycles 中的几何正面必须与原法线一致"
        lights = BAKE.setup_lights({"environment": {"color": [0.4, 0.4, 0.4], "intensity": 1}, "lights": []}, output)
        BAKE.pack_atlases([obj], 256, 8, 16 * 1024 * 1024)
        pixels = BAKE.bake_irradiance([obj], lights, 256, name)
        values = read_centers(pixels, obj, 256)
        assert all(min(value) > 0.05 for value in values), f"{name} 孤立方盒的每个面都必须获得环境光：{values}"
        repeated = read_centers(BAKE.bake_irradiance([obj], lights, 256, name + "-repeated"), obj, 256)
        repeated_difference = max(abs(left - right) for first, second in zip(values, repeated) for left, right in zip(first, second))
        assert repeated_difference < 1e-5, f"{name} 重新烘焙不能累加已有光照"
        validate_exported_source(obj, source, output / f"{name}-geometry.json")
        results.append({"case": name, "faceCount": len(values), "minimum": min(min(value) for value in values),
                        "maximum": max(max(value) for value in values), "repeatMaxDifference": repeated_difference, "values": values})
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=ROOT / "tests" / "lightingBake" / "fixtures" / "actual-seven-surfaces.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--diagnostic", action="store_true")
    parser.add_argument("--orientation-only", action="store_true")
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source = json.loads(arguments.input.read_text(encoding="utf-8"))
    if arguments.output is None:
        arguments.output = Path(tempfile.mkdtemp(prefix="cycles-atlas-validation-"))
    arguments.output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 4
    if arguments.orientation_only:
        report = {"status": "PASS", "orientationChecks": orientation_checks(source["meshes"][0], arguments.output)}
        (arguments.output / "orientation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("CYCLES_ORIENTATION_CHECKS_PASSED " + json.dumps(report), flush=True)
        return
    objects = [BAKE.make_mesh(data, arguments.input.parent, index) for index, data in enumerate(source["meshes"])]
    lights = BAKE.setup_lights(source, arguments.input.parent)
    settings = source["settings"]
    size = settings["atlasSize"]
    pages = BAKE.pack_atlases(objects, size, settings["texelsPerMeter"], settings["maxTextureMiB"] * 1024 * 1024)
    assert len(pages) == 1, "本回归必须把七个对象写入同一图集"
    material_values = [{
        "base": list(obj.data.materials[0].node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value),
        "metallic": obj.data.materials[0].node_tree.nodes.get("Principled BSDF").inputs["Metallic"].default_value,
        "roughness": obj.data.materials[0].node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value,
    } for obj in objects]
    combined = BAKE.bake_irradiance(pages[0], lights, size, "CombinedAtlas")
    BAKE.save_rgbm(combined, size, arguments.output / "combined.png")
    report = {"objects": [], "input": str(arguments.input), "samples": scene.cycles.samples}
    for index, obj in enumerate(objects):
        data = source["meshes"][index]
        group = read_centers(combined, obj, size)
        result = {"name": data["name"], "key": data["key"], "combined": group,
                  "litCombinedFaces": sum(max(value) > 1e-6 for value in group)}
        if arguments.all or not arguments.diagnostic or "Column" in data["name"]:
            single = BAKE.bake_irradiance([obj], lights, size, f"Single-{index}")
            BAKE.save_rgbm(single, size, arguments.output / f"single-{index}.png")
            result["single"] = read_centers(single, obj, size)
            result["litSingleFaces"] = sum(max(value) > 1e-6 for value in result["single"])
            result["maxDifference"] = max(abs(a - b) for left, right in zip(group, result["single"]) for a, b in zip(left, right))
        report["objects"].append(result)
        print(json.dumps({key: value for key, value in result.items() if key not in ("combined", "single")}, ensure_ascii=False), flush=True)
        validate_exported_source(obj, data, arguments.output / f"geometry-{index}.json")
    # 同一个已使用的图集再次烘焙，结果不能翻倍或保留上一次累积光照。
    if not arguments.diagnostic:
        repeat = BAKE.bake_irradiance(pages[0], lights, size, "RepeatedAtlas")
        for result, obj in zip(report["objects"], objects):
            result["repeatMaxDifference"] = max(abs(a - b) for left, right in zip(result["combined"], read_centers(repeat, obj, size)) for a, b in zip(left, right))
            assert result["litSingleFaces"] > 0, f"{result['name']} 的单对象物理基准不能全黑"
            assert result["maxDifference"] < 1e-5, f"{result['name']} 的共享图集遗漏或改变了三角面光照"
            assert result["repeatMaxDifference"] < 1e-5, f"{result['name']} 重烘焙发生光照累加"
    for index, obj in enumerate(objects):
        shader = obj.data.materials[0].node_tree.nodes.get("Principled BSDF")
        assert material_values[index] == {"base": list(shader.inputs["Base Color"].default_value),
            "metallic": shader.inputs["Metallic"].default_value, "roughness": shader.inputs["Roughness"].default_value}, "烘焙不能改原材质参数"
    report["status"] = "ATLAS_PASSED"
    (arguments.output / "atlas-face-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if not arguments.diagnostic:
        report["orientationChecks"] = orientation_checks(source["meshes"][0], arguments.output)
        report["status"] = "PASS"
    (arguments.output / "atlas-face-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_ATLAS_INTEGRITY_PASSED " + str(arguments.output), flush=True)


if __name__ == "__main__":
    main()
