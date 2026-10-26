"""真实 Blender 数据块上的探针 GPU 预算/失败注入；不冒充硬件 GPU 实测。"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import bpy
from mathutils import Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MIB = 1024 * 1024


def load_module(file: Path):
    spec = importlib.util.spec_from_file_location("probe_gpu_contract", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_budget(module) -> dict:
    selected = {"id": "CUDA_NVIDIA_Test_0000:01:00", "name": "NVIDIA Test", "backend": "CUDA", "actual": "GPU"}
    rows = "GPU-other, 00000000:02:00.0, NVIDIA Test, 8192, 7168\nGPU-selected, 00000000:01:00.0, NVIDIA Test, 2048, 1024\n"
    with patch.object(module.shutil, "which", return_value="nvidia-smi"), patch.object(
            module.subprocess, "run", return_value=SimpleNamespace(stdout=rows)) as run:
        memory = module.query_selected_gpu_memory(selected)
        assert memory["freeBytes"] == 1024 * MIB and memory["totalBytes"] == 2048 * MIB
        assert memory["source"] == "nvidia-smi" and memory["deviceUuid"] == "GPU-selected"
        assert run.call_args.kwargs["timeout"] <= 3 and run.call_args.kwargs["check"]
        ambiguous = module.query_selected_gpu_memory({**selected, "id": "unknown"})
        assert ambiguous["freeBytes"] is None and ambiguous["reason"]
    for stdout in ("N/A", "GPU-selected, 00000000:01:00.0, NVIDIA Test, N/A, N/A", "GPU-selected, 00000000:01:00.0, NVIDIA Test, 2048, 4096"):
        with patch.object(module.shutil, "which", return_value="nvidia-smi"), patch.object(
                module.subprocess, "run", return_value=SimpleNamespace(stdout=stdout)):
            assert module.query_selected_gpu_memory(selected)["freeBytes"] is None
    for error in (OSError("missing"), subprocess.TimeoutExpired("nvidia-smi", 2), subprocess.CalledProcessError(1, "nvidia-smi")):
        with patch.object(module.shutil, "which", return_value="nvidia-smi"), patch.object(module.subprocess, "run", side_effect=error):
            assert module.query_selected_gpu_memory(selected)["freeBytes"] is None
    with patch.object(module.shutil, "which", return_value=None):
        assert module.query_selected_gpu_memory(selected)["freeBytes"] is None
    assert module.query_selected_gpu_memory({**selected, "backend": "HIP"})["freeBytes"] is None
    bpy.context.scene.cycles.device = "CPU"
    assert module.probe_batch_plan()["imageSize"] == 1024
    assert module.probe_batch_plan()["batchSize"] == 4816
    bpy.context.scene.cycles.device = "GPU"
    module.BAKE_DEVICE_SELECTION = selected
    cases = []
    for available, expected in ((None, 256), (8192 * MIB, 1024), (1024 * MIB, 512), (32 * MIB, 128)):
        with patch.object(module, "query_selected_gpu_memory", return_value={"freeBytes": available, "totalBytes": None, "source": "injected", "reason": "injected unknown" if available is None else None}):
            plan = module.probe_batch_plan()
        assert plan["imageSize"] == expected and plan["reason"]
        capacities = []
        while plan is not None:
            assert plan["batchSize"] <= (plan["imageSize"] // 6) ** 2 // 6
            capacities.append([plan["imageSize"], plan["batchSize"]])
            next_plan = module.smaller_probe_batch(plan)
            if next_plan is not None:
                assert next_plan["imageSize"] < plan["imageSize"]
                assert next_plan["batchSize"] <= plan["batchSize"]
            plan = next_plan
        assert capacities[-1][0] == 128 and capacities[-1][1] <= 64
        cases.append({"freeBytes": available, "tiers": capacities})
    for message in ("CUDA out of memory", "HIP hipErrorOutOfMemory", "Failed to allocate device memory", "Metal: Insufficient Memory"):
        assert module.is_gpu_out_of_memory_error(RuntimeError(message)), message
    for message in ("CUDA error: illegal address", "device lost", "invalid device", "no kernel image", "UV layer missing", "cancelled",
                    "CUDA error: invalid argument in memory allocation", "failed to allocate: invalid allocation size",
                    "memory allocation failed: invalid value", "failed to allocate image handle"):
        assert not module.is_gpu_out_of_memory_error(RuntimeError(message)), message
    return {"memoryMatching": "selected PCI; duplicate names refused", "tiers": cases}


def legacy_marker_count(module, device: str, injected_error: BaseException) -> int:
    """独立调用修改前脚本的 bake_diffuse，核对原服务回退协议。"""
    def fail_bake(**kwargs):
        raise injected_error

    fake_bpy = SimpleNamespace(context=SimpleNamespace(scene=SimpleNamespace(cycles=SimpleNamespace(device=device))),
                               ops=SimpleNamespace(object=SimpleNamespace(bake=fail_bake)))
    errors = io.StringIO()
    with patch.object(module, "bpy", fake_bpy), contextlib.redirect_stderr(errors):
        try:
            module.bake_diffuse()
        except BaseException as actual:
            assert actual is injected_error
        else:
            raise AssertionError("失败必须原样传播")
    return errors.getvalue().count("LIGHTING_BAKE_GPU_FALLBACK")


def check_retry(module, output: Path, legacy=None) -> list[dict]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    light = bpy.data.objects.new("ExistingLight", bpy.data.lights.new("ExistingLight", "POINT"))
    bpy.context.collection.objects.link(light)
    results = []
    cases = (("second-pass-oom", RuntimeError("CUDA out of memory"), False, 2, "GPU", 80),
             ("later-batch-oom", RuntimeError("CUDA out of memory"), False, 4, "GPU", 300),
             ("exhausted-oom", RuntimeError("CUDA out of memory"), True, 0, "GPU", 80),
             ("non-oom", RuntimeError("CUDA error: illegal address"), True, 0, "GPU", 80),
             ("device-lost", RuntimeError("CUDA error: device lost"), True, 0, "GPU", 80),
             ("invalid-device", RuntimeError("invalid device"), True, 0, "GPU", 80),
             ("invalid-allocation", RuntimeError("CUDA error: failed to allocate: invalid allocation size"), True, 0, "GPU", 80),
             ("invalid-argument", RuntimeError("CUDA error: invalid argument in memory allocation"), True, 0, "GPU", 80),
             ("generic-error", RuntimeError("UV layer missing"), True, 0, "GPU", 80),
             ("cancelled", KeyboardInterrupt("cancelled"), True, 0, "GPU", 80),
             ("cpu-oom", RuntimeError("out of memory"), True, 0, "CPU", 80))
    for label, injected_error, always_fail, fail_call, device, count in cases:
        scene.cycles.device = device
        positions = [Vector((index * 0.01, 0, 0)) for index in range(count)]
        folder = output / label
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / "probes.json"
        sentinel = "existing result must survive failed attempts"
        target.write_text(sentinel, encoding="utf-8")
        before = tuple(len(getattr(bpy.data, name)) for name in ("objects", "meshes", "materials", "images"))
        calls, sizes, hidden = [], [], []

        def fake_bake(**kwargs):
            obj = bpy.context.view_layer.objects.active
            image = obj.data.materials[0].node_tree.nodes.active.image
            size = image.size[0]
            mesh = obj.data
            axes = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
            for face in mesh.polygons:
                assert face.normal.dot(module.vector(list(axes[face.index % 6]))) > 0.999
                x, y = face.index % (size // 6) * 6, face.index // (size // 6) * 6
                assert y + 5 < size
                for loop, (u, v) in zip(face.loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                    expected_uv = Vector(((x + 1 + u * 4) / size, (y + 1 + v * 4) / size))
                    assert (mesh.uv_layers["LightmapUV"].data[loop].uv - expected_uv).length < 1e-7
            calls.append(kwargs)
            sizes.append(size)
            hidden.append(light.hide_render)
            if always_fail or len(calls) == fail_call:
                raise injected_error
            pixels = np.zeros(size * size * 4, dtype=np.float32)
            pixels.reshape(-1, 4)[:, :3] = 0.25
            image.pixels.foreach_set(pixels)

        fake_bpy = SimpleNamespace(context=bpy.context, data=bpy.data,
                                   ops=SimpleNamespace(object=SimpleNamespace(bake=fake_bake,
                                       select_all=bpy.ops.object.select_all)))
        captured, errors = io.StringIO(), io.StringIO()
        with patch.object(module, "bpy", fake_bpy), patch.object(module, "query_selected_gpu_memory", return_value={
                "freeBytes": None, "totalBytes": None, "source": "injected", "reason": "test unknown memory"}), contextlib.redirect_stdout(captured), contextlib.redirect_stderr(errors):
            try:
                count = module.bake_probes([], [light], 1, folder, positions)
                assert label in ("second-pass-oom", "later-batch-oom") and count == len(positions)
            except BaseException as actual:
                if label in ("second-pass-oom", "later-batch-oom"):
                    raise
                assert actual is injected_error
        after = tuple(len(getattr(bpy.data, name)) for name in ("objects", "meshes", "materials", "images"))
        assert before == after, (label, before, after)
        assert not light.hide_render and not module.PROBE_GPU_RETRY_ACTIVE
        if label in ("second-pass-oom", "later-batch-oom"):
            probes = json.loads(target.read_text(encoding="utf-8"))["probes"]
            assert len(probes) == len(positions) and all(probe["irradiance"] == [0.5] * 18 for probe in probes)
            assert [probe["position"] for probe in probes] == [list(module.REVERSE_COORDINATES.to_3x3() @ point) for point in positions]
            expected_sizes = [256, 256, 128, 128, 128, 128] if label == "second-pass-oom" else [256, 256, 256, 256, 128, 128]
            assert sizes == expected_sizes and hidden == [False, True, False, True, False, True]
            assert "LIGHTING_BAKE_GPU_FALLBACK" not in errors.getvalue()
            report = json.loads((folder / "probe-batches.json").read_text(encoding="utf-8"))
            assert report["status"] == "completed" and report["oomRetries"] == 1
            expected_statuses = ["oom-retry", "completed", "completed"] if label == "second-pass-oom" else ["completed", "oom-retry", "completed"]
            assert [attempt["status"] for attempt in report["attempts"]] == expected_statuses
            assert report["bakeCalls"] == 6 and [attempt["bakeCalls"] for attempt in report["attempts"]] == [2, 2, 2]
        else:
            assert target.read_text(encoding="utf-8") == sentinel
            reference_markers = legacy_marker_count(legacy or module, device, injected_error)
            assert errors.getvalue().count("LIGHTING_BAKE_GPU_FALLBACK") == reference_markers
            if label == "exhausted-oom":
                assert sizes == [256, 128] and errors.getvalue().count("LIGHTING_BAKE_GPU_FALLBACK") == 1
            else:
                assert sizes == ([1024] if device == "CPU" else [256])
                expected_markers = 1 if label in ("non-oom", "device-lost", "invalid-device", "invalid-allocation", "invalid-argument") else 0
                assert errors.getvalue().count("LIGHTING_BAKE_GPU_FALLBACK") == expected_markers
            report = json.loads((folder / "probe-batches.json").read_text(encoding="utf-8"))
            assert report["status"] in ("failed", "cancelled")
            assert report["bakeCalls"] == len(sizes)
        assert "LIGHTING_BAKE_PROBE_BATCHES " in captured.getvalue()
        results.append({"case": label, "imageSizes": sizes, "resourceCountsBefore": before, "resourceCountsAfter": after,
                        "fallbackMarkers": errors.getvalue().count("LIGHTING_BAKE_GPU_FALLBACK"), "diagnostics": report})
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--legacy-script", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = (args.output or Path(tempfile.mkdtemp(prefix="cycles-probe-gpu-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    module = load_module(args.bake_script)
    legacy = load_module(args.legacy_script) if args.legacy_script else None
    devices = module.discover_bake_devices()
    report = {"status": "PASS", "blender": bpy.app.version_string, "availableDevices": devices,
              "gpuEvidence": "failure injection with real Blender data blocks; not hardware GPU execution",
              "legacyReference": str(args.legacy_script) if args.legacy_script else "standalone bake_diffuse contract",
              "budget": check_budget(module), "retry": check_retry(module, output, legacy)}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_PROBE_GPU_CHECKS_PASS " + json.dumps({"status": "PASS", "availableDevices": devices, "cases": len(report["retry"])}), flush=True)


if __name__ == "__main__":
    main()
