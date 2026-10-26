"""真实 Blender 嵌入解释器的 Gamma helper 导入/PNG/状态恢复微回归，不执行 Cycles。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import time
import types

import bpy
import numpy as np


def load_actual_script(source: Path, target: Path, name: str):
    shutil.copyfile(source, target)
    module = types.ModuleType(name)
    module.__file__ = str(target)
    sys.modules[name] = module
    # Blender --python 也是执行主脚本；不用source loader为主脚本人为制造字节码缓存。
    exec(compile(target.read_text(encoding="utf-8"), str(target), "exec"), module.__dict__)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = args.output.resolve()
    output.mkdir(exist_ok=False)
    started = time.perf_counter()
    report = {"pass": False, "blenderVersion": bpy.app.version_string, "numpyVersion": np.__version__,
              "ignoreEnvironment": sys.flags.ignore_environment, "startupDontWriteBytecode": sys.dont_write_bytecode,
              "environmentDontWriteBytecode": __import__("os").environ.get("PYTHONDONTWRITEBYTECODE"), "cases": []}
    original_flag = sys.dont_write_bytecode
    try:
        pixels = np.array([1, 4, .25, 1, 0, 0, 0, 1, .0001, .004, .16, 1, 4, 1, .25, 1], dtype=np.float32)
        for failure in [False, True]:
            directory = output / ("failure" if failure else "success")
            directory.mkdir()
            helper = directory / "rgbm_gamma_codec.py"
            shutil.copyfile(args.source.with_name("rgbm_gamma_codec.py"), helper)
            if failure:
                with helper.open("a", encoding="utf-8") as stream:
                    stream.write('\nraise RuntimeError("phase2 controlled import failure")\n')
            module = load_actual_script(args.source, directory / "cycles_bake.py", "phase2_gamma_failure" if failure else "phase2_gamma_success")
            sys.dont_write_bytecode = False
            entry = {"name": "failure" if failure else "success", "beforeDontWriteBytecode": sys.dont_write_bytecode}
            original_pixels = pixels.copy()
            try:
                scale = module.save_rgbm(pixels, 2, directory / "gamma.png", "rgbm-gamma")
                assert not failure
                entry["range"] = scale
                module.save_rgbm(pixels, 2, directory / "linear.png")
            except RuntimeError as error:
                assert failure and str(error) == "phase2 controlled import failure"
                entry["expectedError"] = str(error)
            entry["afterDontWriteBytecode"] = sys.dont_write_bytecode
            entry["files"] = sorted(path.name for path in directory.iterdir())
            entry["noPycache"] = not (directory / "__pycache__").exists()
            entry["flatDirectory"] = all(path.is_file() for path in directory.iterdir())
            assert entry["noPycache"] and entry["flatDirectory"] and not sys.dont_write_bytecode
            assert np.array_equal(original_pixels, pixels)
            if not failure:
                # 模块由真实save_rgbm加载；这里只取其已验证独立算法的量化预期，与PNG原字节另行比较。
                codec = __import__("importlib.util", fromlist=["util"])
                spec = codec.spec_from_file_location("phase2_gamma_expected", helper)
                expected_module = codec.module_from_spec(spec)
                sys.dont_write_bytecode = True
                try:
                    spec.loader.exec_module(expected_module)
                finally:
                    sys.dont_write_bytecode = False
                _, encoded = expected_module.encode_rgbm_gamma_pixels(pixels)
                entry["expectedGammaBottomFirstBytes"] = np.floor(encoded * np.float32(255) + np.float32(.5)).astype(np.uint8).tolist()
                _, encoded_linear = module.encode_rgbm_pixels(pixels)
                entry["expectedLinearBottomFirstBytes"] = np.floor(encoded_linear * np.float32(255) + np.float32(.5)).astype(np.uint8).tolist()
                entry["linearIrradiance"] = pixels.tolist()
            report["cases"].append(entry)
        report["pass"] = True
    finally:
        sys.dont_write_bytecode = original_flag
        report["finalDontWriteBytecode"] = sys.dont_write_bytecode
        report["elapsedSeconds"] = time.perf_counter() - started
        (output / "blender-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
