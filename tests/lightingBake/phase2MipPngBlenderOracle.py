"""B9 微型实测：真实 Blender PNG 量化/行向和 EXTEND 边角；不烘焙项目场景。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import time
import zlib

import bpy
import numpy as np


def decode_png(path: Path) -> np.ndarray:
    """独立的最小 RGBA8 PNG oracle，不通过 Blender 再加载掩盖行向或色彩变换。"""
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    compressed, offset = bytearray(), 8
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind, payload = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]
        assert zlib.crc32(kind + payload) & 0xffffffff == struct.unpack_from(">I", data, offset + 8 + length)[0]
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            assert (depth, color, compression, filtering, interlace) == (8, 6, 0, 0, 0)
        elif kind == b"IDAT":
            compressed.extend(payload)
        offset += length + 12
    stride = width * 4
    raw = zlib.decompress(compressed)
    assert len(raw) == height * (stride + 1)
    result = np.zeros((height, stride), dtype=np.uint8)
    for row in range(height):
        mode = raw[row * (stride + 1)]
        for col in range(stride):
            value = raw[row * (stride + 1) + 1 + col]
            left = int(result[row, col - 4]) if col >= 4 else 0
            above = int(result[row - 1, col]) if row else 0
            corner = int(result[row - 1, col - 4]) if row and col >= 4 else 0
            if mode == 1:
                value += left
            elif mode == 2:
                value += above
            elif mode == 3:
                value += (left + above) // 2
            elif mode == 4:
                p = left + above - corner
                distances = (abs(p - left), abs(p - above), abs(p - corner))
                value += (left, above, corner)[distances.index(min(distances))]
            else:
                assert mode == 0
            result[row, col] = value & 255
    return result.reshape(height, width, 4)


def png_oracle(output: Path) -> dict:
    candidates = []
    for value in range(255):
        midpoint = np.float32((value + .5) / 255)
        candidates.extend([np.nextafter(midpoint, np.float32(0)), midpoint, np.nextafter(midpoint, np.float32(1))])
    candidates.extend(np.arange(256, dtype=np.float32) / np.float32(255))
    values = np.resize(np.asarray(candidates, dtype=np.float32), 1024 * 2 * 4)
    rgba = values.reshape(2, 1024, 4)
    rgba[0, 0] = (1, 0, .25, 1)
    rgba[1, 0] = (0, .5, 1, 1)
    original = values.copy()
    image = bpy.data.images.new("phase2-b9-quantization", width=1024, height=2, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.alpha_mode = "CHANNEL_PACKED"
    image.pixels.foreach_set(values)
    assigned = np.empty_like(values)
    image.pixels.foreach_get(assigned)
    path = output / "quantization.png"
    image.filepath_raw, image.file_format = str(path), "PNG"
    image.save()
    bpy.data.images.remove(image)
    top_first = decode_png(path)
    bottom_first = top_first[::-1].copy()
    assert np.array_equal(bottom_first[0, 0], [255, 0, 64, 255])
    assert np.array_equal(bottom_first[1, 0], [0, 128, 255, 255])
    actual = bottom_first.reshape(-1)
    formulas = {
        "floor-float64-x255-plus-half": np.floor(values.astype(np.float64) * 255 + .5).astype(np.uint8),
        "floor-float32-x255-plus-half": np.floor(values * np.float32(255) + np.float32(.5)).astype(np.uint8),
        "rint-float64-x255": np.rint(values.astype(np.float64) * 255).astype(np.uint8),
        "rint-float32-x255": np.rint(values * np.float32(255)).astype(np.uint8),
    }
    # 保存完整的已输入 float32 及实际 bytes，后续 helper 不凭少数颜色猜量化规则。
    (output / "quantization-input-f32.bin").write_bytes(values.astype("<f4").tobytes())
    (output / "quantization-bottom-first-u8.bin").write_bytes(actual.tobytes())
    return {"width": 1024, "height": 2, "channels": values.size, "pngRowOrder": "top-first",
            "blenderPixelsRowOrder": "bottom-first", "firstBottomRgba": actual[:4].tolist(),
            "firstTopRgba": actual[4096:4100].tolist(), "sourceUnchanged": bool(np.array_equal(values, original)),
            "formulas": {name: {"mismatchChannels": int(np.count_nonzero(actual != result)),
                                   "firstMismatches": np.flatnonzero(actual != result)[:8].tolist()}
                         for name, result in formulas.items()},
            "foreachSetHasAlreadyQuantized": bool(np.max(np.abs(assigned - values)) > 0),
            "pngSha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def extend_oracle(output: Path) -> dict:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine, scene.cycles.device = "CYCLES", "CPU"
    scene.cycles.samples, scene.cycles.use_denoising = 1, False
    scene.render.threads_mode, scene.render.threads = "FIXED", 2
    scene.render.bake.margin_type = "EXTEND"
    mesh = bpy.data.meshes.new("phase2-b9-margin-triangle")
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    uv = mesh.uv_layers.new(name="LightmapUV")
    for index, point in enumerate([(20 / 64, 20 / 64), (28 / 64, 20 / 64), (20 / 64, 28 / 64)]):
        uv.data[index].uv = point
    obj = bpy.data.objects.new(mesh.name, mesh)
    scene.collection.objects.link(obj)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    material = bpy.data.materials.new("phase2-b9-margin-emission")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    emission, target = tree.nodes.new("ShaderNodeEmission"), tree.nodes.new("ShaderNodeOutputMaterial")
    emission.inputs[0].default_value = (1, .25, .125, 1)
    tree.links.new(emission.outputs[0], target.inputs["Surface"])
    mesh.materials.append(material)
    reports = []
    for margin in [0, 3]:
        image = bpy.data.images.new(f"phase2-b9-margin-{margin}", width=64, height=64, alpha=True, float_buffer=True)
        image.colorspace_settings.name = "Non-Color"
        image.alpha_mode = "CHANNEL_PACKED"
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image, tree.nodes.active = image, node
        scene.render.bake.margin = margin
        bpy.ops.object.bake(type="EMIT")
        pixels = np.empty(64 * 64 * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        rgba = pixels.reshape(64, 64, 4)
        nonzero = np.argwhere(rgba[:, :, 0] > .5)
        yy, xx = np.mgrid[0:64, 0:64]
        # 独立的严格半平面定义；资格来自几何，固定自发光颜色只用作此次实际bake覆盖oracle。
        interior = (xx + .5 > 20) & (yy + .5 > 20) & (xx + yy + 1 < 48)
        assert int(interior.sum()) == 28
        assert np.all(rgba[interior] == np.array([1, .25, .125, 1], dtype=np.float32))
        if margin == 0:
            assert np.array_equal(rgba[:, :, 0] > .5, interior)
        probes = {f"{x},{y}": rgba[y, x].tolist() for x, y in [(17, 17), (18, 18), (19, 19), (16, 20), (17, 20), (20, 17), (20, 20), (28, 20), (30, 20)]}
        np.save(output / f"extend-margin-{margin}-linear.npy", rgba)
        reports.append({"margin": margin, "nonzeroPixels": len(nonzero), "strictInteriorSeeds": int(interior.sum()),
                        "everyStrictSeedMatchesActualBake": True,
                        "boundsYX": [nonzero.min(0).tolist(), nonzero.max(0).tolist()], "probesXY": probes})
        tree.nodes.remove(node)
        bpy.data.images.remove(image)
    return {"marginType": scene.render.bake.margin_type, "atlasSize": 64,
            "uvTexelEdgeTriangle": [[20, 20], [28, 20], [20, 28]], "cases": reports,
            "limit": "只证明本固定三角形与Blender版本的观测，不能证明任意chart的dilation半径。"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    report = {"blenderVersion": bpy.app.version_string, "numpyVersion": np.__version__, "output": str(output), "pass": False}
    try:
        report["png"] = png_oracle(output)
        report["extend"] = extend_oracle(output)
        report["pass"] = True
    finally:
        report["elapsedSeconds"] = time.perf_counter() - started
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PHASE2_MIP_PNG_ORACLE " + json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
