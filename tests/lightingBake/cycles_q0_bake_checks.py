"""真实 Cycles 中逐项验证 B1、B2，再验证组合；保留每次 bake 与 PNG 对照。"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import time
from types import FunctionType

import bpy
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load_module(file: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure_scene(module, input_file: Path, samples: int):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 20261024
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 4
    data = json.loads(input_file.read_text(encoding="utf-8"))
    objects = [module.make_mesh(copy.deepcopy(source), input_file.parent, index)
               for index, source in enumerate(data["meshes"])]
    lights = module.setup_lights(data, input_file.parent)
    return objects, lights, data


def png_bytes(file: Path) -> np.ndarray:
    image = bpy.data.images.load(str(file), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    values = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(values)
    bpy.data.images.remove(image)
    return np.rint(values.astype(np.float64) * 255).astype(np.int16)


def atlas_run(module, label: str, input_file: Path, output: Path) -> dict:
    objects, lights, data = configure_scene(module, input_file, 16)
    settings = data["settings"]
    size = settings["atlasSize"]
    pages = module.pack_atlases(objects, size, settings["texelsPerMeter"], settings["maxTextureMiB"] * 1048576)
    results = []
    for index, page in enumerate(pages):
        started = time.perf_counter()
        pixels = module.bake_irradiance(page, lights, size, f"Atlas-{index}")
        baked = time.perf_counter()
        file = output / f"{label}-atlas-{index}.png"
        dynamic_range = module.save_rgbm(pixels, size, file)
        saved = time.perf_counter()
        results.append({"index": index, "range": dynamic_range, "size": size,
                        "bakeAndMergeMs": (baked - started) * 1000, "saveRgbmMs": (saved - baked) * 1000,
                        "file": str(file)})
    return {"atlases": results}


def probe_run(module, label: str, input_file: Path, output: Path, count: int) -> dict:
    objects, lights, _ = configure_scene(module, input_file, 128)
    # 放在孤立场景外，用非黑环境保证每个六方向数值都实际参与比较。
    positions = [Vector((100 + index % 8 * 0.5, 100 + index // 8 % 8 * 0.5, 10 + index // 64 * 0.5))
                 for index in range(count)]
    folder = output / label
    folder.mkdir(exist_ok=True)
    bake_calls = []
    original = module.bake_diffuse

    def measured_bake():
        started = time.perf_counter()
        original()
        bake_calls.append((time.perf_counter() - started) * 1000)

    module.bake_diffuse = measured_bake
    started = time.perf_counter()
    try:
        module.bake_probes(objects, lights, 1, folder, positions)
    finally:
        module.bake_diffuse = original
    duration = (time.perf_counter() - started) * 1000
    data = json.loads((folder / "probes.json").read_text(encoding="utf-8"))
    values = np.asarray([probe["irradiance"] for probe in data["probes"]])
    assert values.shape == (count, 18) and values.max() > 0.01
    return {"durationMs": duration, "bakeCalls": len(bake_calls), "bakeCallMs": bake_calls,
            "probeCount": count, "values": values, "positions": [probe["position"] for probe in data["probes"]]}


def public_probe(result: dict) -> dict:
    return {key: value for key, value in result.items() if key not in ("values", "positions")}


def compare_probes(reference: dict, actual: dict) -> dict:
    assert reference["positions"] == actual["positions"], "探针的世界位置及顺序必须保持"
    difference = actual["values"] - reference["values"]
    maximum = float(np.max(np.abs(difference)))
    rms = float(np.sqrt(np.mean(difference ** 2)))
    relative_rms = rms / max(1e-9, float(np.sqrt(np.mean(reference["values"] ** 2))))
    assert maximum <= 0.03 and relative_rms <= 0.02, (maximum, relative_rms)
    return {"components": int(difference.size), "differentComponents": int(np.count_nonzero(difference)),
            "maxAbsoluteDifference": maximum, "rmsDifference": rms, "relativeRms": relative_rms}


def scalar_probe_samples(pixels, size: int, count: int) -> np.ndarray:
    rows = []
    for index in range(count):
        row = []
        for face in range(6):
            tile = index * 6 + face
            x, y = tile % (size // 6) * 6 + 2, tile // (size // 6) * 6 + 2
            for channel in range(3):
                row.append(sum(pixels[((y + dy) * size + x + dx) * 4 + channel]
                               for dx in range(2) for dy in range(2)) / 4)
        rows.append(row)
    return np.asarray(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-script", type=Path, required=True)
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage", choices=("b1", "combined"), default="combined")
    parser.add_argument("--probe-count", type=int, default=65)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    baseline = load_module(args.baseline_script, "baseline_q0")
    candidate = load_module(args.bake_script, "candidate_q0")
    fixture = ROOT / "tests/lightingBake/fixtures/actual-seven-surfaces.json"
    report = {"blender": bpy.app.version_string, "numpy": np.__version__, "device": "CPU", "seed": 20261024,
              "stage": args.stage, "baselineScript": str(args.baseline_script), "candidateScript": str(args.bake_script)}
    old_atlas = atlas_run(baseline, "baseline", fixture, args.output)
    new_atlas = atlas_run(candidate, "candidate", fixture, args.output)
    comparisons = []
    assert len(old_atlas["atlases"]) == len(new_atlas["atlases"])
    for old, new in zip(old_atlas["atlases"], new_atlas["atlases"]):
        assert old["range"] == new["range"]
        difference = np.abs(png_bytes(Path(old["file"])) - png_bytes(Path(new["file"])))
        assert difference.max() <= 1
        comparisons.append({"index": old["index"], "components": int(difference.size),
                            "maxByteDifference": int(difference.max()),
                            "differentComponents": int(np.count_nonzero(difference))})
    report["atlases"] = {"baseline": old_atlas, "candidate": new_atlas, "comparisons": comparisons}
    old_probes = probe_run(baseline, "baseline-probes", fixture, args.output, args.probe_count)
    if args.stage == "combined":
        assert candidate.PROBE_IMAGE_SIZE == 1024
        assert candidate.PROBE_BATCH_SIZE == 4816
        # B2 独立路径保留原合并和采样，确保批次收益不混入 B1。
        batching = load_module(args.bake_script, "batching_only_q0")
        batching.bake_irradiance = FunctionType(baseline.bake_irradiance.__code__, batching.__dict__)
        batching.sample_probe_irradiance = scalar_probe_samples
        batched_probes = probe_run(batching, "b2-only-probes", fixture, args.output, args.probe_count)
        assert batched_probes["bakeCalls"] == 2
        report["b2Only"] = {"statistics": public_probe(batched_probes), "comparison": compare_probes(old_probes, batched_probes)}
    new_probes = probe_run(candidate, "candidate-probes", fixture, args.output, args.probe_count)
    report["probes"] = {"baseline": public_probe(old_probes), "candidate": public_probe(new_probes),
                         "comparison": compare_probes(old_probes, new_probes)}
    if args.stage == "b1":
        assert new_probes["bakeCalls"] == old_probes["bakeCalls"]
        assert report["probes"]["comparison"]["maxAbsoluteDifference"] == 0
    else:
        assert new_probes["bakeCalls"] == 2
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_Q0_BAKE_CHECKS_PASS " + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
