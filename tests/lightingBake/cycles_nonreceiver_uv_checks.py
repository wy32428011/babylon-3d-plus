"""仅AST提取候选纯谓词；不导入bpy、不执行Cycles或修改产品文件。"""
from __future__ import annotations
import argparse
from array import array
import ast
import copy
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    tree = ast.parse(args.candidate.read_text(encoding="utf-8"))
    functions = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == "can_skip_nonreceiver_lightmap_uv"]
    assert len(functions) == 1
    namespace = {"array": array, "math": math}
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<isolated-nonreceiver-predicate>", "exec"), namespace)
    predicate = namespace[functions[0].name]
    source = {"positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "receiver": False,
              "uvs": [0, 0, 1, 0, 0, 1], "material": {"baseColor": [1, 1, 1], "alpha": 1}}
    checks = []

    def check(name, value, expected):
        assert predicate(value) is expected, name
        checks.append({"name": name, "skip": expected})

    check("constant-opaque", source, True)
    for value in [True, None, 0, "false"]:
        changed = copy.deepcopy(source); changed["receiver"] = value
        check("receiver-" + str(value), changed, False)
    changed = copy.deepcopy(source); del changed["receiver"]; check("default-receiver", changed, False)
    for mode in ["mask", "blend", "mask-blend"]:
        changed = copy.deepcopy(source); changed["material"].update(alphaMode=mode, useVertexAlpha=True,
            textures={"baseColor": {"coordinatesIndex": 0}})
        check("explicit-uv1-" + mode, changed, True)
    changed = copy.deepcopy(source); changed["uvs2"] = array("d", [0, 0, 0, 1, 1, 0])
    changed["material"].update(emissive=[2, 1, 0], textures={"normal": {"coordinatesIndex": 1}, "emissive": {"coordinatesIndex": 1}})
    check("uv2-normal-emission-array", changed, True)
    for mutate, name in [
        (lambda value: value.pop("uvs2"), "missing-uv2"),
        (lambda value: value.update(uvs2=[0, 0]), "short-uv2"),
        (lambda value: value.update(uvs2=[0, 0, 0, 1, float("nan"), 0]), "nan-uv2"),
        (lambda value: value["material"].update(customShader=True), "unknown-material"),
        (lambda value: value["material"]["textures"].update(vendorUnknown={"coordinatesIndex": 1}), "unknown-texture"),
        (lambda value: value["material"]["textures"]["normal"].update(coordinatesIndex=2), "unknown-channel"),
        (lambda value: value["material"]["textures"]["normal"].update(coordinatesIndex=True), "boolean-channel"),
    ]:
        value = copy.deepcopy(changed); mutate(value); check(name, value, False)
    check("unknown-input", [], False)
    print("CYCLES_NONRECEIVER_UV_CONTRACT " + json.dumps({"status": "PASS", "checks": checks}))


if __name__ == "__main__":
    main()
