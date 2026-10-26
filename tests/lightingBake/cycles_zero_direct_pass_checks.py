"""B4 零直射跳过的保守判定和像素 oracle；contract 模式不导入 bpy。"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def socket(value=0, linked=False):
    return SimpleNamespace(default_value=value, is_linked=linked, links=[])


def node(kind, **inputs):
    return SimpleNamespace(bl_idname=kind, inputs=inputs, animation_data=None, operation="MULTIPLY", mute=False,
                           is_active_output=True, target="ALL")


def fixture():
    shader = node("ShaderNodeBsdfPrincipled", **{"Emission Color": socket((0, 0, 0, 1)), "Emission Strength": socket(1)})
    output = node("ShaderNodeOutputMaterial", Surface=socket(linked=True), Volume=socket())
    output.inputs["Surface"].links = [SimpleNamespace(from_node=shader)]
    material = SimpleNamespace(use_nodes=True, animation_data=None,
                               node_tree=SimpleNamespace(nodes=[shader, output], animation_data=None))
    mesh = SimpleNamespace(type="MESH", hide_render=False, instance_type="NONE", modifiers=[],
                           material_slots=[SimpleNamespace(material=material)])
    light = SimpleNamespace(type="LIGHT", hide_render=False, name="key-light", instance_type="NONE")
    background = node("ShaderNodeBackground", Color=socket((0.1, 0.2, 0.3, 1)), Strength=socket(0))
    world_output = node("ShaderNodeOutputWorld", Surface=socket(linked=True), Volume=socket())
    world_output.inputs["Surface"].links = [SimpleNamespace(from_node=background)]
    world = SimpleNamespace(use_nodes=True, animation_data=None,
                            node_tree=SimpleNamespace(nodes=[background, world_output], animation_data=None))
    scene = SimpleNamespace(world=world, objects=[mesh, light], render=SimpleNamespace(engine="CYCLES"))
    return SimpleNamespace(scene=scene, light=light, shader=shader, material=material, mesh=mesh,
                           background=background, world=world, world_output=world_output)


def load_helpers(file):
    names = {"can_skip_zero_direct_pass", "bake_irradiance", "merge_irradiance_pixels"}
    tree = ast.parse(file.read_text(encoding="utf-8"))
    functions = [entry for entry in tree.body if isinstance(entry, ast.FunctionDef) and entry.name in names]
    assert {entry.name for entry in functions} == names, "B4 helpers missing"
    source = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
    import math
    namespace = {"np": np, "math": math}
    exec(compile(ast.fix_missing_locations(source), str(file), "exec"), namespace)
    return namespace


def eligibility_checks(can_skip):
    good = fixture()
    assert can_skip(good.scene, [good.light])
    good.scene.world = None
    assert can_skip(good.scene, [good.light])
    rejected = []
    mutations = {
        "nonzero-world": lambda f: setattr(f.background.inputs["Strength"], "default_value", 0.01),
        "linked-world-strength": lambda f: setattr(f.background.inputs["Strength"], "is_linked", True),
        "world-animation": lambda f: setattr(f.world.node_tree, "animation_data", object()),
        "world-volume": lambda f: setattr(f.world_output.inputs["Volume"], "is_linked", True),
        "world-unknown": lambda f: f.world.node_tree.nodes.append(node("ShaderNodeGroup")),
        "world-other-target": lambda f: setattr(f.world_output, "target", "EEVEE"),
        "world-multiple-outputs": lambda f: f.world.node_tree.nodes.append(node("ShaderNodeOutputWorld")),
        "positive-emission": lambda f: setattr(f.shader.inputs["Emission Color"], "default_value", (0.1, 0, 0, 1)),
        "linked-emission": lambda f: setattr(f.shader.inputs["Emission Color"], "is_linked", True),
        "linked-emission-strength": lambda f: setattr(f.shader.inputs["Emission Strength"], "is_linked", True),
        "material-animation": lambda f: setattr(f.material.node_tree, "animation_data", object()),
        "material-other-target": lambda f: setattr(f.material.node_tree.nodes[1], "target", "EEVEE"),
        "material-multiple-outputs": lambda f: f.material.node_tree.nodes.append(node("ShaderNodeOutputMaterial")),
        "scalar-emission-color": lambda f: (setattr(f.shader.inputs["Emission Color"], "default_value", 0),
                                              setattr(f.shader.inputs["Emission Strength"], "default_value", 0)),
        "unknown-shader": lambda f: f.material.node_tree.nodes.append(node("ShaderNodeEmission")),
        "node-group": lambda f: f.material.node_tree.nodes.append(node("ShaderNodeGroup")),
        "unmatched-light": lambda f: f.scene.objects.append(SimpleNamespace(type="LIGHT", hide_render=False, name="unlisted-light", instance_type="NONE")),
        "light-instancer": lambda f: setattr(f.light, "instance_type", "COLLECTION"),
        "modifier": lambda f: f.mesh.modifiers.append(object()),
        "instancer": lambda f: setattr(f.mesh, "instance_type", "COLLECTION"),
        "unknown-geometry": lambda f: f.scene.objects.append(SimpleNamespace(type="VOLUME", hide_render=False)),
        "no-material": lambda f: setattr(f.mesh, "material_slots", []),
        "nan-emission": lambda f: setattr(f.shader.inputs["Emission Color"], "default_value", (np.nan, 0, 0, 1)),
        "missing-input": lambda f: f.shader.inputs.pop("Emission Strength"),
        "non-node-material": lambda f: setattr(f.material, "use_nodes", False),
    }
    for name, mutate in mutations.items():
        current = fixture()
        mutate(current)
        assert not can_skip(current.scene, [current.light]), name
        rejected.append(name)
    return rejected


def pipeline_checks(namespace):
    calls, removed = [], []
    first = np.tile(np.asarray([0.25, -0.0, 2.5, 0.1, -1, np.nan, np.inf, 0], dtype=np.float32), 2)
    oracle = first.copy()
    for index in range(0, len(oracle), 4):
        for channel in range(3):
            oracle[index + channel] = max(0, float(oracle[index + channel]) + 0.0)
        oracle[index + 3] = 1

    def run(eligible=True, fail=False):
        current = fixture()
        if not eligible:
            current.background.inputs["Strength"].default_value = 1
        bake = SimpleNamespace()
        current.scene.render.bake = bake
        image = SimpleNamespace(colorspace_settings=SimpleNamespace(), pixels=SimpleNamespace())
        image.pixels.foreach_get = lambda output: np.copyto(output, first if len(calls) == 1 else np.zeros_like(first))
        images = SimpleNamespace(new=lambda *args, **kwargs: image, remove=lambda value: removed.append(value))
        namespace["bpy"] = SimpleNamespace(context=SimpleNamespace(scene=current.scene), data=SimpleNamespace(images=images))
        namespace["attach_target"] = lambda *args: None

        def bake_diffuse():
            calls.append((bake.use_pass_direct, bake.use_pass_indirect, current.light.hide_render))
            if fail:
                raise RuntimeError("original bake failure")

        namespace["bake_diffuse"] = bake_diffuse
        calls.clear()
        try:
            result = namespace["bake_irradiance"]([current.mesh], [current.light], 2, "fixture")
        except RuntimeError as error:
            assert fail and str(error) == "original bake failure"
            result = None
        assert current.light.hide_render is False
        assert removed[-1] is image
        return result

    optimized = run()
    assert len(calls) == 1
    np.testing.assert_array_equal(optimized.view(np.uint32), oracle.view(np.uint32))
    fallback = run(False)
    assert len(calls) == 2 and calls[1] == (True, False, True)
    np.testing.assert_array_equal(fallback.view(np.uint32), oracle.view(np.uint32))
    run(fail=True)
    assert len(calls) == 1
    return {"optimizedBakeCalls": 1, "fallbackBakeCalls": 2, "failureCleanup": True}


def contract(file, output):
    helpers = load_helpers(file)
    rejected = eligibility_checks(helpers["can_skip_zero_direct_pass"])
    pipeline = pipeline_checks(helpers)
    report = {"status": "PASS", "scope": "Python fake Blender contract, not real Cycles pixels", "rejectedCases": rejected, **pipeline}
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CYCLES_ZERO_DIRECT_PASS_CONTRACT " + json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake-script", type=Path, default=ROOT / "electron/lighting-bake/cycles_bake.py")
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    contract(arguments.bake_script, arguments.output)
