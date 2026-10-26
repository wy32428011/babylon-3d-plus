"""生成六种 EXR 压缩的本地测试原图，并核对 Cycles 仍使用原图和旋转。"""
from array import array
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

import bpy

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=False)
scene = bpy.context.scene
settings = scene.render.image_settings
settings.file_format = "OPEN_EXR"
settings.color_mode = "RGB"
settings.color_depth = "16"
image = bpy.data.images.new("NativeSkyboxFixture", width=64, height=32, float_buffer=True)
image.colorspace_settings.name = "Non-Color"
pixels = array("f")
for y in range(32):
    for x in range(64):
        sun = 8.0 if 12 <= x <= 15 and 20 <= y <= 23 else 0.0
        pixels.extend([0.03 + x / 64 + sun, 0.05 + y / 32 + sun, 0.1 + (x + y) / 96 + sun, 1.0])
image.pixels.foreach_set(pixels)
resources = []
for codec in ["NONE", "RLE", "ZIPS", "ZIP", "PIZ", "PXR24"]:
    settings.exr_codec = codec
    target = output / f"{codec}.exr"
    image.save_render(str(target), scene=scene)
    content = target.read_bytes()
    resources.append({"codec": codec, "file": target.name, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)})
bpy.data.images.remove(image)

# 直接调用实际后端，不使用 bpy 替身；ENV 不进入 Cycles 的环境贴图节点。
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_skybox_bake", root / "electron/lighting-bake/cycles_bake.py")
bake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bake)
rotation = math.radians(37)
bake.setup_lights({"environment": {"color": [0.1, 0.1, 0.1], "intensity": 0.8,
                  "textureFile": "NONE.exr", "rotation": rotation}, "lights": []}, output)
nodes = bpy.context.scene.world.node_tree.nodes
textures = [node for node in nodes if node.bl_idname == "ShaderNodeTexEnvironment"]
assert len(textures) == 1 and Path(textures[0].image.filepath).resolve() == output / "NONE.exr"
mapping = next(node for node in nodes if node.bl_idname == "ShaderNodeMapping")
assert abs(mapping.inputs["Rotation"].default_value[2] + rotation) < 1e-6
background = next(node for node in nodes if node.bl_idname == "ShaderNodeBackground")
assert abs(background.inputs["Strength"].default_value - 0.8) < 1e-6
(output / "manifest.json").write_text(json.dumps({"resources": resources, "cycles": {
    "version": bpy.app.version_string, "texture": "NONE.exr", "rotation": rotation, "intensity": 0.8,
    "checks": ["actual-setup-lights", "original-exr-node", "rotation", "intensity"]}}, indent=2), encoding="utf-8")
print("NATIVE_SKYBOX_EXR_FIXTURES_PASS", str(output), flush=True)
