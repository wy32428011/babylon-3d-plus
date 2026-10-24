"""在真实 Blender 网格上与独立旧角点导出逐字节比较；不改烘焙配置。"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys
import tempfile

import bpy

ROOT = Path(__file__).resolve().parents[2]
CHANNELS = (("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2), ("colors", 4), ("tangents", 4), ("bakeUvs", 2))


def load_module(file: Path):
    spec = importlib.util.spec_from_file_location("geometry_weld_contract", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def old_corners(obj, source: dict) -> dict:
    """独立保留 v1 的逐角点算法，不调用候选的收集/去重 helper。"""
    result = {"version": 1, "key": source["key"], "positions": [], "normals": [], "indices": [], "uvs": [], "bakeUvs": []}
    for name in ("uvs2", "colors", "tangents"):
        if name in source:
            result[name] = []
    for face in obj.data.polygons:
        loops = list(face.loop_indices)
        if obj["source_winding_flipped"][face.index]:
            loops = [loops[0], loops[2], loops[1]]
        for loop_index in loops:
            index = obj.data.loops[loop_index].vertex_index
            for name, width in CHANNELS:
                if name == "bakeUvs":
                    result[name].extend(obj.data.uv_layers["LightmapUV"].data[loop_index].uv)
                elif name == "uvs" and name not in source:
                    result[name].extend((0, 0))
                elif name in source:
                    result[name].extend(source[name][index * width:index * width + width])
            result["indices"].append(len(result["indices"]))
    return result


def bytes64(values) -> bytes:
    return struct.pack("<" + "d" * len(values), *values)


def compare_expanded(reference: dict, actual: dict) -> None:
    assert actual["version"] == 2
    assert len(actual["indices"]) == len(reference["indices"])
    for name, width in CHANNELS:
        assert (name in actual) == (name in reference), name
        if name in reference:
            values = [value for index in actual["indices"] for value in actual[name][index * width:index * width + width]]
            assert bytes64(values) == bytes64(reference[name]), name


def fixture(label: str, seam: str | None = None):
    mesh = bpy.data.meshes.new(label)
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2), (0, 2, 3)])
    uv = mesh.uv_layers.new(name="LightmapUV")
    for loop in mesh.loops:
        uv.data[loop.index].uv = [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)][loop.vertex_index]
    if seam == "bakeUvs":
        uv.data[3].uv = (0.2, 0.2)
    obj = bpy.data.objects.new(label, mesh)
    bpy.context.collection.objects.link(obj)
    obj["source_winding_flipped"] = [0, 0]
    source = {"key": label, "positions": [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
              "normals": [0, 0, 1] * 4, "indices": [0, 1, 2, 0, 2, 3], "uvs": [0, 0, 1, 0, 1, 1, 0, 1],
              "uvs2": [0.1, 0.2] * 4, "colors": [0.5, 0.6, 0.7, 0.8] * 4, "tangents": [1, 0, 0, -1] * 4}
    return obj, source


def duplicate_attribute_fixture(channel: str):
    obj, source = fixture("attribute-" + channel)
    mesh = obj.data
    coordinates = [tuple(vertex.co) for vertex in mesh.vertices]
    mesh.clear_geometry()
    mesh.from_pydata(coordinates + [coordinates[0], coordinates[2]], [], [(0, 1, 2), (4, 5, 3)])
    uv = mesh.uv_layers.new(name="LightmapUV") if not mesh.uv_layers else mesh.uv_layers["LightmapUV"]
    mapping = [0, 1, 2, 3, 0, 2]
    for loop in mesh.loops:
        uv.data[loop.index].uv = [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9)][mapping[loop.vertex_index]]
    for name, width in CHANNELS:
        if name in source:
            source[name].extend(source[name][:width] + source[name][2 * width:3 * width])
    source["indices"] = [0, 1, 2, 4, 5, 3]
    width = dict(CHANNELS)[channel]
    value = source[channel][4 * width]
    source[channel][4 * width] = -0.0 if value == 0 else math.nextafter(value, math.inf)
    return obj, source


def grid_fixture(side: int):
    values = [(x / side, y / side, 0) for y in range(side + 1) for x in range(side + 1)]
    faces = []
    for y in range(side):
        for x in range(side):
            index = y * (side + 1) + x
            faces.extend([(index, index + 1, index + side + 2), (index, index + side + 2, index + side + 1)])
    mesh = bpy.data.meshes.new("grid")
    mesh.from_pydata(values, [], faces)
    uv = mesh.uv_layers.new(name="LightmapUV")
    for loop in mesh.loops:
        uv.data[loop.index].uv = values[loop.vertex_index][:2]
    obj = bpy.data.objects.new("grid", mesh)
    bpy.context.collection.objects.link(obj)
    obj["source_winding_flipped"] = [0] * len(faces)
    source = {"key": "grid", "positions": [value for row in values for value in row], "normals": [0, 0, 1] * len(values),
              "indices": [value for row in faces for value in row], "uvs": [value for row in values for value in row[:2]]}
    return obj, source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    module = load_module(args.bake_script)
    output = (args.output or Path(tempfile.mkdtemp(prefix="cycles-weld-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    for label, seam, absent, flipped in (("weld", None, False, False), ("uv-seam", "bakeUvs", False, False),
                                         ("absent-channels", None, True, False), ("winding", None, False, True)):
        obj, source = fixture(label, seam)
        if absent:
            for key in ("uvs", "uvs2", "colors", "tangents"):
                source.pop(key)
        if flipped:
            obj["source_winding_flipped"] = [1, 0]
        reference = old_corners(obj, source)
        path = output / f"{label}-v2.json"
        module.export_geometry(obj, source, path)
        actual = json.loads(path.read_text(encoding="utf-8"))
        compare_expanded(reference, actual)
        expected = [0, 1, 2, 3, 2, 4] if seam else ([0, 1, 2, 0, 1, 3] if flipped else [0, 1, 2, 0, 2, 3])
        assert actual["indices"] == expected, (label, actual["indices"])
        (output / f"{label}-v1.json").write_text(json.dumps(reference, separators=(",", ":")), encoding="utf-8")
        cases.append({"case": label, "corners": len(reference["indices"]), "vertices": len(actual["positions"]) // 3,
                      "v1Bytes": (output / f"{label}-v1.json").stat().st_size, "v2Bytes": path.stat().st_size})
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    for channel in ("positions", "normals", "uvs", "uvs2", "colors", "tangents"):
        obj, source = duplicate_attribute_fixture(channel)
        reference = old_corners(obj, source)
        path = output / f"attribute-{channel}-v2.json"
        module.export_geometry(obj, source, path)
        actual = json.loads(path.read_text(encoding="utf-8"))
        compare_expanded(reference, actual)
        assert actual["indices"] == [0, 1, 2, 3, 2, 4], channel
        cases.append({"case": "attribute-" + channel, "corners": 6, "vertices": len(actual["positions"]) // 3,
                      "exactIeeeBoundaryRetained": True})
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    obj, source = grid_fixture(32)
    reference = old_corners(obj, source)
    path = output / "grid-v2.json"
    module.export_geometry(obj, source, path)
    actual = json.loads(path.read_text(encoding="utf-8"))
    compare_expanded(reference, actual)
    (output / "grid-v1.json").write_text(json.dumps(reference, separators=(",", ":")), encoding="utf-8")
    assert len(actual["positions"]) // 3 == 33 * 33
    cases.append({"case": "grid", "corners": len(reference["indices"]), "vertices": len(actual["positions"]) // 3,
                  "v1Bytes": (output / "grid-v1.json").stat().st_size, "v2Bytes": path.stat().st_size})
    report = {"status": "PASS", "blender": bpy.app.version_string, "cases": cases}
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("CYCLES_GEOMETRY_WELD_CHECKS_PASS " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
