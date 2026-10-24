"""stdlib 聚焦检查实际生产 gate；真实 Blender 导出另由集成夹具验证。"""
import ast
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from array import array


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "electron/lighting-bake/cycles_bake.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
names = {"encode_export_geometry_binary", "write_export_geometry", "write_json"}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
namespace = {"json": json, "math": math, "struct": struct, "array": array, "sys": sys,
             "_binary_sys": sys, "Path": Path, "Any": object}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)] + functions,
                        type_ignores=[])), str(SOURCE), "exec"), namespace)


def fixture():
    return {"version": 2, "key": "a/root", "positions": [-0.0, 0, 0, 1, 0, 0, 0, 1, 0],
            "normals": [0, 0, 1] * 3, "uvs": [0, 0, 1, 0, 0, 1], "bakeUvs": [0, 0, 1, 0, 0, 1],
            "uvs2": [0, 0.5] * 3, "colors": [0.5] * 12, "tangents": [1, 0, 0, -1] * 3, "indices": [0, 1, 2]}


class BinaryGateChecks(unittest.TestCase):
    def test_actual_gate_exists(self):
        self.assertTrue(callable(namespace.get("encode_export_geometry_binary")), "产品尚无严格无损二进制 gate")

    def test_exact_all_channels_and_signed_zero(self):
        result = fixture()
        encoded = namespace["encode_export_geometry_binary"](result)
        self.assertEqual(encoded[:8], b"BLGOUT01")
        length = struct.unpack_from("<I", encoded, 8)[0]
        header = json.loads(encoded[12:12 + length])
        self.assertEqual(header["geometryVersion"], 2)
        for name, layout in header["attributes"].items():
            code = "I" if name == "indices" else "f"
            values = struct.unpack_from("<" + code * layout["count"], encoded, layout["byteOffset"])
            self.assertEqual(len(values), len(result[name]))
            for actual, expected in zip(values, result[name]):
                self.assertEqual(struct.pack("<d", actual), struct.pack("<d", expected), name)

    def test_every_channel_decimal_nextafter_overflow_underflow_falls_back(self):
        for name in ("positions", "normals", "uvs", "uvs2", "colors", "tangents", "bakeUvs"):
            for value in (0.1, math.nextafter(1, math.inf), 1e300, 2 ** -150):
                result = fixture()
                result[name][0] = value
                self.assertIsNone(namespace["encode_export_geometry_binary"](result), (name, value))
        exact = fixture()
        exact["positions"][0] = 2 ** -149
        self.assertIsNotNone(namespace["encode_export_geometry_binary"](exact))

    def test_whole_block_json_fallback_is_byte_identical_to_old_writer(self):
        with tempfile.TemporaryDirectory(prefix="b7-gate-") as directory:
            root = Path(directory)
            result = fixture()
            result["uvs2"][0] = 0.1
            namespace["write_json"](root / "old.json", result)
            metadata = namespace["write_export_geometry"](result, root / "geometry-0")
            self.assertEqual(metadata, {"geometryFile": "geometry-0.json", "geometryVersion": 2})
            self.assertEqual((root / "geometry-0.json").read_bytes(), (root / "old.json").read_bytes())
            self.assertFalse((root / "geometry-0.bin").exists())
            metadata = namespace["write_export_geometry"](fixture(), root / "geometry-1")
            self.assertEqual(metadata, {"geometryFile": "geometry-1.bin", "geometryVersion": 2, "encoding": "binary-v1"})

    def test_key_eligibility_matches_js_utf16_and_old_json(self):
        for key, binary in (("x" * 4096, True), ("x" * 4097, False), ("😀" * 2048, True),
                            ("😀" * 2049, False), ("has\0nul", False)):
            result = fixture()
            result["key"] = key
            self.assertEqual(namespace["encode_export_geometry_binary"](result) is not None, binary)
            if not binary:
                with tempfile.TemporaryDirectory(prefix="b7-key-") as directory:
                    root = Path(directory)
                    namespace["write_json"](root / "old.json", result)
                    metadata = namespace["write_export_geometry"](result, root / "new")
                    self.assertEqual(metadata["geometryFile"], "new.json")
                    self.assertEqual((root / "old.json").read_bytes(), (root / "new.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
