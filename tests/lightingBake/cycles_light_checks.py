"""比较真实 Cycles 光照与编辑器的距离、聚光角度衰减比值。"""
from array import array
import importlib.util
import math
from pathlib import Path
import tempfile

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cycles_bake", ROOT / "electron" / "lighting-bake" / "cycles_bake.py")
BAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BAKE)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 32


def receiver(distance: float, angle: float) -> object:
    position = Vector((math.sin(angle) * distance, 0, -math.cos(angle) * distance))
    normal = -position.normalized()
    tangent = Vector((0, 1, 0))
    bitangent = normal.cross(tangent)
    vertices = [position + tangent * x * 0.01 + bitangent * y * 0.01 for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]
    mesh = bpy.data.meshes.new("Sample")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new(name="LightmapUV")
    for loop, value in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = value
    obj = bpy.data.objects.new("Sample", mesh)
    bpy.context.collection.objects.link(obj)
    material = bpy.data.materials.new("White")
    material.use_nodes = True
    material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1, 1, 1, 1)
    obj.data.materials.append(material)
    return obj


def measure(distance: float, angle: float) -> float:
    obj = receiver(distance, angle)
    image = bpy.data.images.new("SampleImage", width=4, height=4, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    BAKE.attach_target([obj], image)
    scene.render.bake.use_pass_color = False
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = False
    bpy.ops.object.bake(type="DIFFUSE")
    value = sum(image.pixels[index * 4] for index in range(16)) / 16
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.images.remove(image)
    return value


with tempfile.TemporaryDirectory(prefix="cycles-light-test-") as temporary:
    lights = BAKE.setup_lights({"environment": {"color": [0, 0, 0], "intensity": 1}, "lights": [
        {"kind": "point", "position": [0, 0, 0], "direction": [0, -1, 0], "color": [1, 1, 1], "intensity": 1,
         "range": 10, "falloff": "standard"},
    ]}, Path(temporary))
    near, far = measure(2, 0), measure(4, 0)
    expected = (1 - 2 / 10) / (1 - 4 / 10)
    assert near > 0 and far > 0 and abs(near / far - expected) < 0.03, (near, far, expected)
    assert measure(12, 0) < 1e-6
    for light in lights:
        bpy.data.objects.remove(light, do_unlink=True)
    lights = BAKE.setup_lights({"environment": {"color": [0, 0, 0], "intensity": 1}, "lights": [
        {"kind": "spot", "position": [0, 0, 0], "direction": [0, -1, 0], "color": [1, 1, 1], "intensity": 1,
         "range": 10, "falloff": "standard", "angle": math.radians(70), "exponent": 8},
    ]}, Path(temporary))
    center, angled = measure(3, 0), measure(3, math.radians(20))
    expected = math.cos(math.radians(20)) ** 8
    assert center > 0 and angled > 0 and abs(angled / center - expected) < 0.03, (center, angled, expected)
    assert measure(3, math.radians(50)) < 1e-6
    for light in lights:
        bpy.data.objects.remove(light, do_unlink=True)
    for kind in ("point", "spot"):
        lights = BAKE.setup_lights({"environment": {"color": [0, 0, 0], "intensity": 1}, "lights": [
            {"kind": kind, "position": [0, 0, 0], "direction": [0, -1, 0], "color": [1, 1, 1],
             "intensity": 1, "falloff": "standard", "angle": math.radians(70), "exponent": 8},
        ]}, Path(temporary))
        near, far = measure(2, 0), measure(4, 0)
        assert near > 0 and far > 0 and abs(near / far - 1) < 0.03, (kind, "unbounded-standard", near, far)
        print("CYCLES_UNBOUNDED_STANDARD", kind, near / far, flush=True)
        for light in lights:
            bpy.data.objects.remove(light, do_unlink=True)
print("CYCLES_LIGHT_CHECKS_PASSED", flush=True)
