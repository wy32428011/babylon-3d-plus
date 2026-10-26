"""用冻结 Q0 脚本和候选真实 CPU 烘焙，对照 PNG 与所有导出角点。"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load(file: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-script", type=Path, required=True)
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    driver = load(ROOT / "tests/lightingBake/cycles_q0_bake_checks.py", "q0_bake_driver")
    oracle = load(ROOT / "tests/lightingBake/cycles_geometry_weld_checks.py", "weld_oracle")
    old = load(args.baseline_script, "q0_geometry_baseline")
    candidate = load(args.bake_script, "weld_geometry_candidate")
    fixture = ROOT / "tests/lightingBake/fixtures/actual-seven-surfaces.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    records = []
    for label, module in (("baseline", old), ("candidate", candidate)):
        atlas = driver.atlas_run(module, label, fixture, output)
        geometries = []
        for obj in bpy.data.objects:
            if "input_index" not in obj:
                continue
            index = obj["input_index"]
            path = output / f"{label}-geometry-{index}.json"
            module.export_geometry(obj, data["meshes"][index], path)
            value = json.loads(path.read_text(encoding="utf-8"))
            geometries.append({"index": index, "file": str(path), "bytes": path.stat().st_size,
                               "vertices": len(value["positions"]) // 3, "corners": len(value["indices"]), "data": value})
        records.append({"atlases": atlas["atlases"], "geometries": sorted(geometries, key=lambda entry: entry["index"])})
    png = []
    for baseline, current in zip(records[0]["atlases"], records[1]["atlases"]):
        assert baseline["range"] == current["range"]
        delta = np.abs(driver.png_bytes(Path(baseline["file"])) - driver.png_bytes(Path(current["file"])))
        assert delta.max() == 0
        png.append({"components": int(delta.size), "differentComponents": int(np.count_nonzero(delta)), "maxByteDifference": int(delta.max())})
    geometry = []
    assert len(records[0]["geometries"]) == len(records[1]["geometries"])
    for baseline, current in zip(records[0]["geometries"], records[1]["geometries"]):
        assert baseline["index"] == current["index"] and baseline["data"]["version"] == 1
        oracle.compare_expanded(baseline["data"], current["data"])
        geometry.append({"index": baseline["index"], "corners": baseline["corners"], "v1Vertices": baseline["vertices"],
                         "v2Vertices": current["vertices"], "v1Bytes": baseline["bytes"], "v2Bytes": current["bytes"]})
    report = {"status": "PASS", "device": "CPU", "seed": 20261024, "samples": 16, "blender": bpy.app.version_string,
              "png": png, "geometry": geometry, "atlases": [entry["atlases"] for entry in records]}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_GEOMETRY_BAKE_CHECKS_PASS " + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
