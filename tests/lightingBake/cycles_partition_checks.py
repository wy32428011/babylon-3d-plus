"""验证大单网格切分页的面积、覆盖、属性和真实 Cycles 输出。"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile

import bpy

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cycles_bake", ROOT / "electron" / "lighting-bake" / "cycles_bake.py")
BAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BAKE)


def plane_source() -> dict:
    source = {
        "key": "large-floor/$mesh/primitive:0", "name": "单个完整大地面", "entityId": "large-floor", "nodeKey": "$mesh",
        "positions": [-15, 0, -10, 15, 0, -10, 15, 0, 10, -15, 0, 10],
        "normals": [0, 1, 0] * 4, "indices": [0, 2, 1, 0, 3, 2],
        "worldMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "material": {"baseColor": [0.5, 0.6, 0.7], "alpha": 1, "alphaMode": "opaque",
                     "metallic": 0, "roughness": 0.8, "emissive": [0, 0, 0], "doubleSided": False},
        "uvs": [], "uvs2": [], "colors": [], "tangents": [],
    }
    for offset in range(0, len(source["positions"]), 3):
        x, _, z = source["positions"][offset:offset + 3]
        source["uvs"].extend((x / 30 + 0.5, z / 20 + 0.5))
        source["uvs2"].extend((x / 60 + 0.2, z / 40 + 0.1))
        source["colors"].extend((0.4 + x / 100, 0.4 + z / 100, 0.8, 0.75))
        source["tangents"].extend((1, 0, 0, -1))
    return source


def independent_area(source: dict) -> float:
    matrix = source["worldMatrix"]
    total = 0.0
    for offset in range(0, len(source["indices"]), 3):
        positions = [source["positions"][index * 3:index * 3 + 3] for index in source["indices"][offset:offset + 3]]
        first, second = [tuple(sum(matrix[column * 4 + row] * (point[column] - positions[0][column])
                                   for column in range(3)) for row in range(3)) for point in positions[1:]]
        cross = (first[1] * second[2] - first[2] * second[1],
                 first[2] * second[0] - first[0] * second[2],
                 first[0] * second[1] - first[1] * second[0])
        total += math.hypot(*cross) / 2
    return total


def validate_leaf_tree(parts: list[dict], original_key: str) -> None:
    paths = {part["key"].removeprefix(original_key + "/tile:") for part in parts}
    assert len(paths) == len(parts)
    assert all(path and set(path) <= {"0", "1"} for path in paths)

    def visit(prefix: str) -> None:
        if prefix in paths:
            assert not any(path != prefix and path.startswith(prefix) for path in paths)
            return
        for bit in "01":
            child = prefix + bit
            assert any(path.startswith(child) for path in paths), f"缺失切分子树 {child}"
            visit(child)

    visit("")


def validate_attributes(parts: list[dict], source: dict) -> None:
    for part in parts:
        assert part["material"] == source["material"]
        assert part["entityId"] == source["entityId"] and part["nodeKey"] == source["nodeKey"]
        assert part["worldMatrix"] == source["worldMatrix"]
        for index in range(len(part["positions"]) // 3):
            x, y, z = part["positions"][index * 3:index * 3 + 3]
            assert -15 - 1e-9 <= x <= 15 + 1e-9 and abs(y) < 1e-9 and -10 - 1e-9 <= z <= 10 + 1e-9
            expected = {
                "normals": (0, 1, 0), "uvs": (x / 30 + 0.5, z / 20 + 0.5),
                "uvs2": (x / 60 + 0.2, z / 40 + 0.1),
                "colors": (0.4 + x / 100, 0.4 + z / 100, 0.8, 0.75),
                "tangents": (1, 0, 0, -1),
            }
            for name, values in expected.items():
                actual = part[name][index * len(values):(index + 1) * len(values)]
                assert all(abs(a - b) < 1e-10 for a, b in zip(actual, values)), (name, actual, values)


def contains_triangle(source: dict, offset: int, x: float, z: float) -> bool:
    vertices = [source["positions"][index * 3:index * 3 + 3] for index in source["indices"][offset:offset + 3]]
    crosses = [(second[0] - first[0]) * (z - first[2]) - (second[2] - first[2]) * (x - first[0])
               for first, second in zip(vertices, vertices[1:] + vertices[:1])]
    return min(crosses) > 1e-10 or max(crosses) < -1e-10


def validate_coverage(parts: list[dict]) -> None:
    # 不落在整齐边界上的网格采样，逐点验证既没有孔洞也没有重复覆盖。
    for column in range(29):
        for row in range(19):
            x, z = -15 + (column + 0.371) * 30 / 29, -10 + (row + 0.613) * 20 / 19
            hits = sum(contains_triangle(part, offset, x, z)
                       for part in parts for offset in range(0, len(part["indices"]), 3))
            assert hits == 1, f"覆盖异常 {(x, z, hits)}"


def exported_minimum_density(geometry: dict, matrix: list, atlas_size: int) -> float:
    """独立求像素/世界二次型的最小广义特征值，不复用引擎密度计算。"""
    densities = []
    for offset in range(0, len(geometry["indices"]), 3):
        indices = geometry["indices"][offset:offset + 3]
        positions = [geometry["positions"][index * 3:index * 3 + 3] for index in indices]
        coordinates = [geometry["bakeUvs"][index * 2:index * 2 + 2] for index in indices]
        world_edges = [tuple(sum(matrix[column * 4 + row] * (point[column] - positions[0][column])
                                for column in range(3)) for row in range(3)) for point in positions[1:]]
        pixel_edges = [tuple((point[axis] - coordinates[0][axis]) * atlas_size for axis in range(2))
                       for point in coordinates[1:]]
        world = [sum(a * b for a, b in zip(world_edges[left], world_edges[right])) for left, right in ((0, 0), (0, 1), (1, 1))]
        pixels = [sum(a * b for a, b in zip(pixel_edges[left], pixel_edges[right])) for left, right in ((0, 0), (0, 1), (1, 1))]
        a = world[0] * world[2] - world[1] ** 2
        if a <= 1e-20:
            continue
        b = -(pixels[0] * world[2] + pixels[2] * world[0] - 2 * pixels[1] * world[1])
        c = pixels[0] * pixels[2] - pixels[1] ** 2
        discriminant = max(0, b * b - 4 * a * c)
        eigenvalue = max(0, (-b - math.sqrt(discriminant)) / (2 * a))
        densities.append(math.sqrt(eigenvalue))
    return min(densities, default=math.inf)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--partition-only", action="store_true")
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = arguments.output or Path(tempfile.mkdtemp(prefix="cycles-partition-validation-"))
    output.mkdir(parents=True, exist_ok=True)
    settings = {"atlasSize": 256, "texelsPerMeter": 16, "maxTextureMiB": 16}
    source = plane_source()
    before = copy.deepcopy(source)
    parts = BAKE.partition_receivers([source], settings)
    assert len(parts) >= 2
    assert source == before, "切分不能改写输入"
    assert parts == BAKE.partition_receivers([source], settings), "相同输入必须生成稳定切片"
    validate_leaf_tree(parts, source["key"])
    validate_attributes(parts, source)
    named_source = {**source, "key": "model/tile:010/material/node/primitive:0"}
    named_parts = BAKE.partition_receivers([named_source], settings)
    validate_leaf_tree(named_parts, named_source["key"])
    assert all(part["key"].startswith(named_source["key"] + "/tile:") for part in named_parts)
    assert math.isclose(sum(independent_area(part) for part in parts), 600, rel_tol=1e-10)
    validate_coverage(parts)
    transformed = copy.deepcopy(source)
    transformed["worldMatrix"] = [-1.5, 0, 0, 0, 0, 2, 0, 0, 0.25, 0, 0.75, 0, 1000000, 0, -1000000, 1]
    transformed["material"].update({"alphaMode": "mask-blend", "alpha": 0.8, "alphaCutoff": 0.3, "useVertexAlpha": True})
    transformed["indices"].extend((0, 0, 0))
    transformed_parts = BAKE.partition_receivers([transformed], settings)
    validate_attributes(transformed_parts, transformed)
    validate_leaf_tree(transformed_parts, transformed["key"])
    assert math.isclose(sum(independent_area(part) for part in transformed_parts), 675, rel_tol=1e-9)
    assert sum(independent_area({**part, "indices": part["indices"][offset:offset + 3]}) == 0
               for part in transformed_parts for offset in range(0, len(part["indices"]), 3)) == 1
    occluder = {**source, "receiver": False}
    assert BAKE.partition_receivers([occluder], settings) == [occluder]
    try:
        BAKE.partition_receivers([source], {**settings, "maxTextureMiB": 0.01})
        raise AssertionError("预算不足必须失败")
    except ValueError as error:
        assert "纹理预算" in str(error)
    actual = json.loads((ROOT / "tests" / "lightingBake" / "fixtures" / "actual-seven-surfaces.json").read_text(encoding="utf-8"))
    actual_settings = {"atlasSize": 1024, "texelsPerMeter": 128, "maxTextureMiB": 64}
    actual_parts = BAKE.partition_receivers(actual["meshes"], actual_settings)
    floor = actual["meshes"][-2]
    floor_parts = [part for part in actual_parts if part["entityId"] == floor["entityId"]]
    assert len(floor_parts) >= 2
    validate_leaf_tree(floor_parts, floor["key"])
    assert math.isclose(sum(independent_area(part) for part in actual_parts),
                        sum(independent_area(part) for part in actual["meshes"]), rel_tol=1e-9)
    report = {"success": True, "planeParts": len(parts), "originalTriangles": 2,
              "derivedTriangles": sum(len(part["indices"]) // 3 for part in parts), "planeArea": 600,
              "actualFixtureParts": len(actual_parts), "actualFloorParts": len(floor_parts),
              "actualOriginalTriangles": sum(len(part["indices"]) // 3 for part in actual["meshes"]),
              "actualDerivedTriangles": sum(len(part["indices"]) // 3 for part in actual_parts),
              "coveragePoints": 29 * 19, "transformedArea": 675, "budgetRejection": True}
    if not arguments.partition_only:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 8
        scene.cycles.use_denoising = False
        parts, objects = BAKE.prepare_meshes([source], output, settings)
        validate_attributes(parts, source)
        validate_leaf_tree(parts, source["key"])
        validate_coverage(parts)
        assert math.isclose(sum(independent_area(part) for part in parts), 600, rel_tol=1e-10)
        lights = BAKE.setup_lights({"environment": {"color": [0.4, 0.4, 0.4], "intensity": 1}, "lights": []}, output)
        pages = BAKE.pack_atlases(objects, 256, 16, len(parts) * 256 * 256 * 4)
        assert len(pages) >= 2
        samples, densities = [], []
        for index, page in enumerate(pages):
            pixels = BAKE.bake_irradiance(page, lights, 256, f"Partition-{index}")
            BAKE.save_rgbm(pixels, 256, output / f"partition-{index}.png")
            values = []
            for obj in page:
                uv = obj.data.uv_layers["LightmapUV"]
                for face in obj.data.polygons:
                    u = sum(uv.data[loop].uv.x for loop in face.loop_indices) / 3
                    v = sum(uv.data[loop].uv.y for loop in face.loop_indices) / 3
                    offset = (min(255, int(v * 256)) * 256 + min(255, int(u * 256))) * 4
                    values.append([float(value) for value in pixels[offset:offset + 3]])
                original = parts[obj["input_index"]]
                geometry_path = output / f"geometry-{obj['input_index']}.json"
                BAKE.export_geometry(obj, original, geometry_path)
                exported = json.loads(geometry_path.read_text(encoding="utf-8"))
                for name, width in (("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4)):
                    expected = [value for vertex in original["indices"]
                                for value in original[name][vertex * width:vertex * width + width]]
                    expanded = [value for vertex in exported["indices"] for value in exported[name][vertex * width:vertex * width + width]]
                    assert expanded == expected, f"导出切片必须保留 {name}"
                assert len(exported["indices"]) == len(original["indices"])
                density = exported_minimum_density(exported, original["worldMatrix"], 256)
                assert density >= 16 * (1 - 1e-5), f"实际采样密度 {density} 小于16px/m"
                densities.append(density)
            assert all(min(value) > 0.3 for value in values), f"切片每个面必须收到环境光 {values}"
            samples.append(values)
        report.update({"planeParts": len(parts), "derivedTriangles": sum(len(part["indices"]) // 3 for part in parts),
                       "atlasCount": len(pages), "pageFaceSamples": samples, "minimumTexelsPerMeter": min(densities)})
        # 对真实七表面按实际密度装箱，预算不足必须量化失败，不能用缩小 UV 冒充成功。
        actual_parts, actual_objects = BAKE.prepare_meshes(actual["meshes"], output, actual_settings)
        assert math.isclose(sum(independent_area(part) for part in actual_parts),
                            sum(independent_area(part) for part in actual["meshes"]), rel_tol=1e-9)
        for original in actual["meshes"]:
            matching = [part for part in actual_parts if part["entityId"] == original["entityId"] and part["nodeKey"] == original["nodeKey"]]
            if matching[0]["key"] != original["key"]:
                validate_leaf_tree(matching, original["key"])
        try:
            actual_pages = BAKE.pack_atlases(actual_objects, 1024, 128, 64 * 1024 * 1024)
        except ValueError as error:
            assert "纹理预算" in str(error)
            report["actual64MiBBudgetFailure"] = str(error)
            actual_pages = BAKE.pack_atlases(actual_objects, 1024, 128, 128 * 1024 * 1024)
        actual_densities = []
        for index, obj in enumerate(actual_objects):
            target = output / f"actual-geometry-{index}.json"
            BAKE.export_geometry(obj, actual_parts[index], target)
            density = exported_minimum_density(json.loads(target.read_text(encoding="utf-8")), actual_parts[index]["worldMatrix"], 1024)
            assert density >= 128 * (1 - 1e-4), f"实际夹具采样密度 {density} 小于128px/m"
            actual_densities.append(density)
        report.update({"actualAtlasCount": len(actual_pages), "actualFixtureParts": len(actual_parts),
                       "actualTextureBytes": len(actual_pages) * 1024 * 1024 * 4,
                       "actualFloorParts": sum(part["entityId"] == floor["entityId"] for part in actual_parts),
                       "actualDerivedTriangles": sum(len(part["indices"]) // 3 for part in actual_parts),
                       "actualMinimumTexelsPerMeter": min(actual_densities)})
    (output / "partition-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_PARTITION_CHECKS_PASS " + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
