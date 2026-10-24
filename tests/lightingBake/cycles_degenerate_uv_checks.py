"""真实 Blender 回归：保留共线三角面，不能把矩阵舍入伪面积误当成缺失 UV。"""
from __future__ import annotations
import argparse
import copy
from fractions import Fraction
import importlib.util
import json
import math
import struct
from pathlib import Path
import sys
import bpy

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cycles_bake", ROOT / "electron" / "lighting-bake" / "cycles_bake.py")
BAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BAKE)


def fixture() -> dict:
    # 对真实失败网格按删除面二分缩减：1004 面 -> 4 面/6 顶点；仅移除无关材质贴图。
    return json.loads((Path(__file__).parent / "fixtures" / "degenerate-car-uv.json").read_text(encoding="utf-8"))


def exact_cross(points: list[list[float]]) -> list[Fraction]:
    first, second, third = [[Fraction(value) for value in point] for point in points]
    u, v = [[point[axis] - first[axis] for axis in range(3)] for point in (second, third)]
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]


def assert_world_density(geometry: dict, matrix: list[float], size: int, density: float) -> float:
    """从导出的最终图集 UV 与原世界矩阵独立求采样下限，不复用产品 metrics。"""
    minimum = math.inf
    for offset in range(0, len(geometry["indices"]), 3):
        indices = geometry["indices"][offset:offset + 3]
        points = [geometry["positions"][index * 3:index * 3 + 3] for index in indices]
        if exact_cross(points) == [0, 0, 0]:
            continue
        edges = [[sum(matrix[column * 4 + row] * (point[column] - points[0][column]) for column in range(3))
                  for row in range(3)] for point in points[1:]]
        uv = [[geometry["bakeUvs"][index * 2 + axis] * size for axis in range(2)] for index in indices]
        a, b = [[point[axis] - uv[0][axis] for axis in range(2)] for point in uv[1:]]
        determinant = a[0] * b[1] - a[1] * b[0]
        assert abs(determinant) > 0, "真实正面积面必须具有可逆最终 UV"
        du = [(edges[0][axis] * b[1] - edges[1][axis] * a[1]) / determinant for axis in range(3)]
        dv = [(edges[1][axis] * a[0] - edges[0][axis] * b[0]) / determinant for axis in range(3)]
        uu, vv, product = sum(value * value for value in du), sum(value * value for value in dv), sum(u * v for u, v in zip(du, dv))
        maximum = math.sqrt((uu + vv + math.sqrt((uu - vv) ** 2 + 4 * product * product)) / 2)
        measured = 1 / maximum
        assert measured >= density * (1 - 1e-3), f"真实采样密度 {measured} 不能低于目标 {density}"
        minimum = min(minimum, measured)
    return minimum


def check_positive_sliver(output: Path) -> dict:
    source = json.loads((Path(__file__).parent / "fixtures" / "sliver-wall-uv.json").read_text(encoding="utf-8"))
    before = copy.deepcopy(source)
    obj = BAKE.make_mesh(source, output, 2)
    try:
        BAKE.lightmap_metrics(obj, 4)
    except ValueError as error:
        assert "有正面积三角面" in str(error), "必须重现真实后墙细面的 SmartProject 失败"
    else:
        raise AssertionError("真实正面积细面最小输入必须保持 red-capable")
    mesh = obj.data
    materials = list(mesh.materials)
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    for material in materials:
        if not material.users:
            bpy.data.materials.remove(material)
    sources, objects = BAKE.prepare_meshes([source], output, {"atlasSize": 1024, "texelsPerMeter": 4, "maxTextureMiB": 256})
    assert len(sources) == len(objects) == 1
    assert objects[0].get("lighting_uv_repair_count", 0) > 0
    pages = BAKE.pack_atlases(objects, 1024, 4, 256 * 1048576)
    assert len(pages) == 1
    file = output / "sliver-geometry.json"
    BAKE.export_geometry(objects[0], sources[0], file)
    geometry = json.loads(file.read_text(encoding="utf-8"))
    assert len(geometry["indices"]) == len(source["indices"]), "不能删除任何真实细面"
    for name, width in (("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4)):
        if name in source:
            expected = [value for index in source["indices"] for value in source[name][index * width:index * width + width]]
            # B6允许复用相同顶点；合同保留原三角角点各通道的逐位值，而非展开存储布局。
            assert len(geometry["positions"]) % 3 == 0
            assert len(geometry[name]) == len(geometry["positions"]) // 3 * width
            assert all(type(index) is int and 0 <= index < len(geometry[name]) // width for index in geometry["indices"])
            actual = [value for index in geometry["indices"] for value in geometry[name][index * width:index * width + width]]
            assert len(actual) == len(expected)
            assert [struct.pack(">d", value) for value in actual] == [struct.pack(">d", value) for value in expected], f"细面修复不能改变原始 {name}"
    assert source == before
    minimum_density = assert_world_density(geometry, source["worldMatrix"], 1024, 4)
    return {"minimumMeasuredDensity": minimum_density, "sourceTriangles": len(source["indices"]) // 3, "outputTriangles": len(geometry["indices"]) // 3,
            "repairedFaces": objects[0]["lighting_uv_repair_count"], "atlasCount": len(pages), "density": 4}


def main() -> None:
    global BAKE
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--bake-script", type=Path)
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if arguments.bake_script:
        # 常规集成检查实际交付的脚本，避免仅源码通过而 Electron 仍运行旧副本。
        spec = importlib.util.spec_from_file_location("delivered_cycles_bake", arguments.bake_script.resolve())
        BAKE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(BAKE)
    output = Path(arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    source = fixture()
    before = copy.deepcopy(source)
    raw_points = [source["positions"][index * 3:index * 3 + 3] for index in source["indices"][:3]]
    assert exact_cross(raw_points) == [0, 0, 0], "原始面必须由精确数值证明严格共线"
    obj = BAKE.make_mesh(source, output, 0)
    bpy.context.view_layer.update()
    face = obj.data.polygons[0]
    points = [obj.data.vertices[index].co for index in face.vertices]
    local_edges = [point - points[0] for point in points[1:]]
    local_area = local_edges[0].cross(local_edges[1]).length / 2
    transform = obj.matrix_world.to_3x3()
    world_edges = [transform @ edge for edge in local_edges]
    rounded_area = world_edges[0].cross(world_edges[1]).length / 2
    assert local_area == 0 and rounded_area > 0, "必须重现旧链路矩阵舍入造成的伪正面积"
    metrics = BAKE.lightmap_metrics(obj, 4)
    pages = BAKE.pack_atlases([obj], 1024, 4, 16 * 1048576)
    assert len(pages) == 1 and len(obj.data.polygons) == 4, "所有原始三角面都必须保留"
    geometry_file = output / "geometry.json"
    BAKE.export_geometry(obj, source, geometry_file)
    geometry = json.loads(geometry_file.read_text(encoding="utf-8"))
    assert len(geometry["indices"]) == 12
    for name, width in (("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4)):
        if name in source:
            expected = [value for index in source["indices"] for value in source[name][index * width:index * width + width]]
            # B6允许复用相同顶点；合同保留原三角角点各通道的逐位值，而非展开存储布局。
            assert len(geometry["positions"]) % 3 == 0
            assert len(geometry[name]) == len(geometry["positions"]) // 3 * width
            assert all(type(index) is int and 0 <= index < len(geometry[name]) // width for index in geometry["indices"])
            actual = [value for index in geometry["indices"] for value in geometry[name][index * width:index * width + width]]
            assert len(actual) == len(expected)
            assert [struct.pack(">d", value) for value in actual] == [struct.pack(">d", value) for value in expected], f"不得改变原始 {name} 或删除共线角点"
    assert source == before
    # 真正有面积的细三角面仍必须得到有效 UV，主动破坏 UV 后必须继续报错。
    thin = fixture()
    thin.update({"key": "positive-thin", "positions": [0, 0, 0, 1, 0, 0, 1, 0.0001, 0],
                 "normals": [0, 0, 1] * 3, "indices": [0, 1, 2]})
    for name, width in (("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4)):
        if name in thin:
            thin[name] = thin[name][:3 * width]
    thin_object = BAKE.make_mesh(thin, output, 1)
    BAKE.lightmap_metrics(thin_object, 4)
    for entry in thin_object.data.uv_layers["LightmapUV"].data:
        entry.uv = (0, 0)
    try:
        BAKE.lightmap_metrics(thin_object, 4)
    except ValueError as error:
        assert "有正面积三角面" in str(error)
    else:
        raise AssertionError("真正正面积面的 UV 校验不能被弱化")
    report = {"success": True, "originalTriangleCount": 4, "exportedTriangleCount": len(geometry["indices"]) // 3,
              "exactLocalCross": [str(value) for value in exact_cross(raw_points)], "localArea": local_area,
              "roundedWorldArea": rounded_area, "metrics": list(metrics), "density": 4,
              "positiveThinUvValidation": "still-required",
              "minimumMeasuredDensity": assert_world_density(geometry, source["worldMatrix"], 1024, 4)}
    report["positiveSliver"] = check_positive_sliver(output)
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_DEGENERATE_UV_CHECKS_PASS " + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
