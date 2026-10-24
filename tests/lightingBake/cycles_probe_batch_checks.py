"""用实际 Blender 网格验证 4096 探针容量、面顺序、UV 和可调批次，无渲染噪声。"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import bpy
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    spec = importlib.util.spec_from_file_location("probe_batch_contract", args.bake_script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.PROBE_IMAGE_SIZE == 1024
    assert module.PROBE_BATCH_SIZE == 4816
    output = args.output or Path(tempfile.mkdtemp(prefix="cycles-probe-contract-"))
    output.mkdir(parents=True, exist_ok=True)
    results = []
    axes = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    for count, image_size, batch_size in [(4096, 1024, 4816), (65, 1024, 64),
                                          (65, 128, 64), (1, 1024, 1), (0, 1024, 4816)]:
        module.PROBE_IMAGE_SIZE = image_size
        module.PROBE_BATCH_SIZE = batch_size
        batches = []
        original_counts = (len(bpy.data.objects), len(bpy.data.meshes), len(bpy.data.materials))

        def inspect_targets(objects, lights, size, name):
            assert size == image_size and len(objects) == 1
            mesh = objects[0].data
            assert len(mesh.polygons) % 6 == 0
            batches.append(len(mesh.polygons) // 6)
            pixels = np.zeros((size * size, 4), dtype=np.float32)
            columns = size // 6
            for face in mesh.polygons:
                assert face.normal.dot(module.vector(list(axes[face.index % 6]))) > 0.999
                x, y = face.index % columns * 6, face.index // columns * 6
                assert y + 5 < size
                for loop, (u, v) in zip(face.loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                    expected = Vector(((x + 1 + u * 4) / size, (y + 1 + v * 4) / size))
                    assert (mesh.uv_layers["LightmapUV"].data[loop].uv - expected).length < 1e-7
                for dx in range(2):
                    for dy in range(2):
                        pixels[(y + 2 + dy) * size + x + 2 + dx, :3] = [face.index % 6 + 1, dx, dy]
            return pixels.reshape(-1)

        module.bake_irradiance = inspect_targets
        positions = [Vector((index * 0.01, 0, 0)) for index in range(count)]
        assert module.bake_probes([], [], 1, output, positions) == count
        probes = json.loads((output / "probes.json").read_text(encoding="utf-8"))["probes"]
        expected = [value for face in range(6) for value in (face + 1, 0.5, 0.5)]
        assert all(probe["irradiance"] == expected for probe in probes)
        assert len(batches) == (count + batch_size - 1) // batch_size
        assert original_counts == (len(bpy.data.objects), len(bpy.data.meshes), len(bpy.data.materials))
        results.append({"probes": count, "imageSize": image_size, "configuredBatchSize": batch_size, "batches": batches,
                        "requiredBakeCalls": len(batches) * 2})
    report = {"status": "PASS", "blender": bpy.app.version_string, "cases": results}
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("CYCLES_PROBE_BATCH_CHECKS_PASS " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
