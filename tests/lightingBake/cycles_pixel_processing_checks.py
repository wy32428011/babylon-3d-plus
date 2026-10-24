"""用旧标量算法核对像素向量化；不依赖 bpy，可由系统 Python 执行。"""
from __future__ import annotations

import argparse
from array import array
import ast
import json
import math
from pathlib import Path
import sys
import time

import numpy as np


ROOT = Path(__file__).resolve().parents[2]


def load_helpers(file: Path) -> dict:
    names = {"merge_irradiance_pixels", "encode_rgbm_pixels", "sample_probe_irradiance"}
    tree = ast.parse(file.read_text(encoding="utf-8"))
    module = ast.Module(body=[node for node in tree.body
                             if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
    namespace = {"np": np, "math": math}
    exec(compile(module, str(file), "exec"), namespace)
    assert names.issubset(namespace), "必须提供独立可核验的向量化像素入口"
    return namespace


def scalar_merge(first, second) -> np.ndarray:
    result = array("f", first)
    for offset in range(0, len(result), 4):
        for channel in range(3):
            result[offset + channel] = max(0, result[offset + channel] + float(second[offset + channel]))
        result[offset + 3] = 1
    return np.asarray(result)


def scalar_rgbm(pixels) -> tuple[int, np.ndarray]:
    # float() 保留原 Blender array('f') 读取后执行 Python double 算术的顺序。
    maximum = max((float(pixels[index]) for index in range(len(pixels)) if index % 4 != 3), default=1)
    dynamic_range = max(1, math.ceil(maximum))
    encoded = array("f", [0]) * len(pixels)
    for offset in range(0, len(pixels), 4):
        rgb = [float(value) for value in pixels[offset:offset + 3]]
        multiplier = max(1 / 255, math.ceil(max(rgb) / dynamic_range * 255) / 255)
        for channel in range(3):
            encoded[offset + channel] = rgb[channel] / (multiplier * dynamic_range)
        encoded[offset + 3] = multiplier
    return dynamic_range, np.asarray(encoded)


def scalar_probes(pixels, size: int, count: int) -> np.ndarray:
    columns = size // 6
    result = []
    for index in range(count):
        irradiance = []
        for face in range(6):
            tile = index * 6 + face
            x, y = tile % columns * 6 + 2, tile // columns * 6 + 2
            for channel in range(3):
                irradiance.append(sum(float(pixels[((y + dy) * size + x + dx) * 4 + channel])
                                      for dx in range(2) for dy in range(2)) / 4)
        result.append(irradiance)
    return np.asarray(result).reshape(count, 18)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--benchmark-size", type=int, default=256)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None)
    functions = load_helpers(args.bake_script)
    generator = np.random.default_rng(20261024)
    report = {"numpy": np.__version__, "script": str(args.bake_script), "cases": []}
    for label, first, second in [
        ("zero", np.zeros(64, dtype=np.float32), np.zeros(64, dtype=np.float32)),
        ("signed-and-hdr", generator.uniform(-2, 40, 4096).astype(np.float32),
         generator.uniform(-2, 40, 4096).astype(np.float32)),
        ("ceil-boundaries", np.asarray([0, 1 / 255, 1, 0, 0, 254 / 255, 1, 0,
                                       0, np.nextafter(np.float32(1), np.float32(2)), 1, 0,
                                       0, 1e-35, 1e-25, 1], dtype=np.float32), np.zeros(16, dtype=np.float32)),
        ("nan-negative-inf-and-inf-cancellation",
         np.asarray([np.nan, -np.inf, np.inf, np.nan, np.inf, -np.inf, 1, np.inf], dtype=np.float32),
         np.asarray([0, 0, -np.inf, 0, -np.inf, np.inf, 2, np.nan], dtype=np.float32)),
    ]:
        expected = scalar_merge(first, second)
        with np.errstate(invalid="ignore"):
            actual = functions["merge_irradiance_pixels"](first.copy(), second.copy())
        assert actual.dtype == np.float32 and np.array_equal(actual, expected), label
        old_range, old_encoded = scalar_rgbm(expected)
        new_range, new_encoded = functions["encode_rgbm_pixels"](actual)
        assert old_range == new_range and new_encoded.dtype == np.float32, label
        difference = np.abs(np.rint(old_encoded.astype(np.float64) * 255)
                            - np.rint(new_encoded.astype(np.float64) * 255))
        assert difference.max(initial=0) <= 1, label
        report["cases"].append({"case": label, "components": len(actual),
                                "maxByteDifference": int(difference.max(initial=0)),
                                "differentComponents": int(np.count_nonzero(difference)),
                                "exactFloatComponents": int(np.count_nonzero(old_encoded == new_encoded))})
    # 正无穷原本会在 RGBM 动态范围 math.ceil 处失败，不能随 NaN 一起归零。
    for channel in range(3):
        first = np.ones(4, dtype=np.float32)
        first[channel] = np.inf
        second = np.zeros_like(first)
        expected = scalar_merge(first, second)
        actual = functions["merge_irradiance_pixels"](first.copy(), second)
        assert np.array_equal(actual, expected) and np.isposinf(actual[channel])
        for encode in (scalar_rgbm, functions["encode_rgbm_pixels"]):
            try:
                encode(actual)
            except OverflowError:
                pass
            else:
                raise AssertionError("正无穷必须保持旧 RGBM OverflowError")
    report["nonFiniteContract"] = {"nanMergedToZero": True, "negativeInfMergedToZero": True,
                                    "infCancellationMergedToZero": True,
                                    "positiveInfRgbmFailure": "OverflowError", "positiveInfChannelsChecked": 3}
    for size, count in [(128, 64), (1024, 4096), (1024, 4816), (1024, 0)]:
        pixels = generator.uniform(0, 16, size * size * 4).astype(np.float32)
        expected = scalar_probes(pixels, size, count)
        actual = functions["sample_probe_irradiance"](pixels, size, count)
        assert np.array_equal(actual, expected), f"探针瓦片、通道或均值顺序发生变化：{size}/{count}"
    size = args.benchmark_size
    first = generator.uniform(0, 16, size * size * 4).astype(np.float32)
    second = generator.uniform(0, 4, len(first)).astype(np.float32)
    timings = {}
    for label, merge, encode in [("scalar", scalar_merge, scalar_rgbm),
                                  ("vector", functions["merge_irradiance_pixels"], functions["encode_rgbm_pixels"])]:
        started = time.perf_counter()
        merged = merge(first.copy(), second)
        merged_at = time.perf_counter()
        result = encode(merged)
        finished = time.perf_counter()
        timings[label] = {"mergeMs": (merged_at - started) * 1000,
                          "rgbmMs": (finished - merged_at) * 1000,
                          "totalMs": (finished - started) * 1000}
        if label == "scalar":
            reference = result
        else:
            assert result[0] == reference[0] and np.array_equal(result[1], reference[1])
    report["benchmark"] = {"size": size, "timings": timings,
                           "encodedComponents": int(result[1].size), "maxByteDifference": 0,
                           "differentComponents": 0}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    print("CYCLES_PIXEL_PROCESSING_CHECKS_PASS")


if __name__ == "__main__":
    main()
