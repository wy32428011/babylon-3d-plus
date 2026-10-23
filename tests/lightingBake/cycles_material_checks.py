"""在真实 Blender Python 环境验证 RGBM 和原材质数据，不依赖模拟 bpy。"""
from array import array
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import zlib

import bpy

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cycles_bake", ROOT / "electron" / "lighting-bake" / "cycles_bake.py")
BAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BAKE)


def check_rgbm(directory: Path) -> None:
    rgb = [0.18, 1.0, 5.0]
    pixels = array("f", (rgb + [1]) * 8 + ([0.18, 0.08, 0.1, 1]) * 8)
    filename = directory / "rgbm.png"
    scale = BAKE.save_rgbm(pixels, 4, filename)
    image = bpy.data.images.load(str(filename), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    actual = [image.pixels[channel] * image.pixels[3] * scale for channel in range(3)]
    assert all(abs(expected - observed) < 0.025 for expected, observed in zip(rgb, actual)), (rgb, actual, scale)
    small = [image.pixels[32 + channel] * image.pixels[35] * scale for channel in range(3)]
    assert all(abs(expected - observed) < 0.01 for expected, observed in zip([0.18, 0.08, 0.1], small)), small
    bpy.data.images.remove(image)


def check_textures_and_geometry(directory: Path) -> None:
    # 左下红、右下绿、左上蓝、右上白，alpha也不同以检出错误翻转和透明度丢失。
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = bytes([0, 0, 0, 255, 191, 255, 255, 255, 255, 0, 255, 0, 0, 64, 0, 255, 0, 128])
    (directory / "checker.png").write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    material = {
        "baseColor": [0.5, 0.6, 0.7], "alpha": 0.8, "metallic": 0.4, "roughness": 0.3,
        "emissive": [0.1, 0.2, 0.3], "doubleSided": True, "invertNormalMapX": True,
        "textures": {"baseColor": {"file": "checker.png", "coordinatesIndex": 0,
                                      "uScale": 2, "vScale": 3, "uOffset": 0.1, "vOffset": 0.2, "wAng": 0.4,
                                      "level": 1, "invertY": False, "wrapU": 1, "wrapV": 1,
                                      "uvTransform": [1, 0, 0, 0, 1, 0]}}}
    source = {"positions": [0, 0, 0, 1, 0, 0, 0, 0, 1], "normals": [0, 1, 0] * 3, "indices": [0, 2, 1],
              "uvs": [0, 0, 1, 0, 0, 1], "uvs2": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
              "colors": [1, 0.5, 0.25, 0.8] * 3, "key": "checker",
              "worldMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1], "material": material}
    obj = BAKE.make_mesh(source, directory, 0)
    assert list(obj.location) == [2, 4, 3]
    assert obj.data.uv_layers.get("SourceUV") and obj.data.uv_layers.get("SourceUV2") and obj.data.uv_layers.get("LightmapUV")
    assert obj.data.color_attributes.get("SourceColors")
    texture = next(node for node in obj.data.materials[0].node_tree.nodes if node.type == "TEX_IMAGE")
    assert texture.image.size[:] == (2, 2)
    linear_texture = BAKE.texture_nodes(obj.data.materials[0],
        {**material["textures"]["baseColor"], "wrapU": 2, "wrapV": 2}, directory, False)
    assert linear_texture.image != texture.image, "同源文件的颜色与线性通道不能共用可变的图像色彩空间"
    assert linear_texture.image.colorspace_settings.name == "Non-Color"
    assert texture.image.colorspace_settings.name == "sRGB"
    assert linear_texture.extension == "MIRROR"
    actual_alpha = [texture.image.pixels[index * 4 + 3] for index in range(4)]
    assert all(abs(actual - alpha) < 0.005 for actual, alpha in zip(actual_alpha, [0.25, 0.5, 0.75, 1])), actual_alpha
    mapping = next(node for node in obj.data.materials[0].node_tree.nodes if node.type == "MAPPING")
    assert list(mapping.inputs["Scale"].default_value) == [2, 3, 1]
    assert abs(mapping.inputs["Rotation"].default_value.z - 0.4) < 1e-6
    # 实际 Cycles EMIT 烘焙原材质基色图，比较三个 UV 区域，检测翻转、坐标交换和基色丢失。
    mapping.inputs["Scale"].default_value = (1, 1, 1)
    mapping.inputs["Location"].default_value = (0, 0, 0)
    mapping.inputs["Rotation"].default_value = (0, 0, 0)
    texture.interpolation = "Closest"
    nodes, links = obj.data.materials[0].node_tree.nodes, obj.data.materials[0].node_tree.links
    emission = nodes.new("ShaderNodeEmission")
    links.new(nodes.get("Principled BSDF").inputs["Base Color"].links[0].from_socket, emission.inputs["Color"])
    links.new(emission.outputs[0], nodes.get("Material Output").inputs["Surface"])
    target = bpy.data.images.new("ColorVerification", width=128, height=128, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    BAKE.attach_target([obj], target)
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 1
    bpy.ops.object.bake(type="EMIT")
    BAKE.export_geometry(obj, source, directory / "geometry.json")
    exported = json.loads((directory / "geometry.json").read_text(encoding="utf8"))
    assert len(exported["colors"]) == 12
    assert sorted(zip(exported["uvs"][::2], exported["uvs"][1::2])) == sorted(zip(source["uvs"][::2], source["uvs"][1::2]))
    assert sorted(zip(exported["uvs2"][::2], exported["uvs2"][1::2])) == sorted(zip(source["uvs2"][::2], source["uvs2"][1::2]))
    output_uvs = list(zip(exported["uvs"][::2], exported["uvs"][1::2]))
    bake_uvs = list(zip(exported["bakeUvs"][::2], exported["bakeUvs"][1::2]))
    def assert_checker(expected_colors: list[tuple]) -> None:
        for source_uv, expected in zip([(0, 0), (1, 0), (0, 1)], expected_colors):
            vertex = output_uvs.index(source_uv)
            weights = [0.2, 0.2, 0.2]
            weights[vertex] = 0.6
            sample_uv = [sum(bake_uvs[index][axis] * weights[index] for index in range(3)) for axis in range(2)]
            offset = (int(sample_uv[1] * 128) * 128 + int(sample_uv[0] * 128)) * 4
            observed = list(target.pixels[offset:offset + 3])
            assert all(abs(a - b) < 0.03 for a, b in zip(expected, observed)), (source_uv, expected, observed)
    assert_checker([(0.5, 0, 0), (0, 0.3, 0), (0, 0, 0.175)])
    # 更改真实仿射矩阵 U'=1-U，方向变化必须反映到实际 Cycles 像素。
    next(node for node in nodes if node.type == "VECT_MATH" and node.operation == "DOT_PRODUCT").inputs[1].default_value = (-1, 0, 1)
    bpy.ops.object.bake(type="EMIT")
    assert_checker([(0, 0.3, 0), (0.5, 0, 0), (0.5, 0.3, 0.175)])


def write_pixel(directory: Path, name: str, rgba: list[int], width: int = 1, height: int = 1) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = b"".join(bytes([0, *rgba[row * width * 4:(row + 1) * width * 4]]) for row in range(height))
    (directory / name).write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def bake_material_socket(directory: Path, material: dict, socket_name: str, vertex_alpha: float = 1) -> list[float]:
    """用真实 Cycles 计算最终颜色/alpha 图，而不是仅检查节点名称。"""
    source = {
        "positions": [0, 0, 0, 1, 0, 0, 0, 0, 1], "normals": [0, 1, 0] * 3, "indices": [0, 2, 1],
        "uvs": [0, 0, 1, 0, 0, 1], "colors": [1, 1, 1, vertex_alpha] * 3, "key": socket_name,
        "worldMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], "material": material,
    }
    obj = BAKE.make_mesh(source, directory, 100)
    nodes, links = obj.data.materials[0].node_tree.nodes, obj.data.materials[0].node_tree.links
    for node in nodes:
        if node.type == "TEX_IMAGE":
            node.interpolation = "Closest"
    source_socket = nodes.get("Principled BSDF").inputs[socket_name]
    emission = nodes.new("ShaderNodeEmission")
    if source_socket.is_linked:
        links.new(source_socket.links[0].from_socket, emission.inputs["Color"])
    else:
        value = source_socket.default_value
        emission.inputs["Color"].default_value = (value, value, value, 1) if isinstance(value, float) else value
    links.new(emission.outputs[0], nodes.get("Material Output").inputs["Surface"])
    target = bpy.data.images.new("AlphaColorVerification", width=32, height=32, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    BAKE.attach_target([obj], target)
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.device = "CPU"
    bpy.context.scene.cycles.samples = 1
    bpy.ops.object.bake(type="EMIT")
    uv_layer = obj.data.uv_layers["LightmapUV"]
    polygon = obj.data.polygons[0]
    center = [sum(uv_layer.data[index].uv[axis] for index in polygon.loop_indices) / len(polygon.loop_indices)
              for axis in range(2)]
    offset = (int(center[1] * 32) * 32 + int(center[0] * 32)) * 4
    result = list(target.pixels[offset:offset + 3])
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.images.remove(target)
    return result


def check_alpha_modes_and_color_spaces(directory: Path) -> None:
    write_pixel(directory, "alpha-half.png", [128, 128, 128, 128])
    write_pixel(directory, "alpha-three-quarters.png", [128, 128, 128, 192])
    write_pixel(directory, "opaque-zero-alpha.png", [128, 128, 128, 0])
    # GPU readPixels 先返回 v=0 一行；直接PNG编码把这一行放顶部，导出invertY补偿这次坐标转换。
    write_pixel(directory, "gpu-readback.png", [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], 2, 2)
    texture = {
        "file": "alpha-half.png", "coordinatesIndex": 0, "uScale": 1, "vScale": 1,
        "uOffset": 0, "vOffset": 0, "wAng": 0, "level": 1, "colorSpace": "linear",
    }
    base = {
        "baseColor": [1, 1, 1], "alpha": 0.8, "metallic": 0, "roughness": 0.6,
        "emissive": [0, 0, 0], "doubleSided": True, "meshVisibility": 1,
        "useTextureAlpha": True, "useVertexAlpha": False, "textures": {"baseColor": texture},
    }
    checks = [
        ("opaque", {**base, "alphaMode": "opaque", "useTextureAlpha": False, "alpha": 0.2, "meshVisibility": 0.3}, 0.1, 1),
        ("blend", {**base, "alphaMode": "blend", "meshVisibility": 0.5, "useVertexAlpha": True}, 0.5, 0.8 * 128 / 255 * 0.5 * 0.5),
        ("mask-kept", {**base, "alphaMode": "mask", "alphaCutoff": 0.4}, 1, 1),
        ("mask-vertex-before-cutoff", {**base, "alphaMode": "mask", "alphaCutoff": 0.4, "useVertexAlpha": True}, 0.5, 0),
        ("mask-blend", {**base, "alphaMode": "mask-blend", "alphaCutoff": 0.4,
                        "textures": {"baseColor": {**texture, "file": "alpha-three-quarters.png"}}}, 1, 0.8 * 192 / 255),
        ("texture-alpha-disabled", {**base, "alphaMode": "blend", "useTextureAlpha": False}, 1, 0.8),
    ]
    for name, material, vertex_alpha, expected in checks:
        observed = bake_material_socket(directory, material, "Alpha", vertex_alpha)
        assert all(abs(value - expected) < 0.005 for value in observed), (name, expected, observed)
        print("CYCLES_ALPHA", name, observed, flush=True)
    for color_space, expected in (("linear", 128 / 255), ("srgb", ((128 / 255 + 0.055) / 1.055) ** 2.4)):
        material = {**base, "alphaMode": "opaque", "useTextureAlpha": False,
                    "textures": {"baseColor": {**texture, "colorSpace": color_space}}}
        observed = bake_material_socket(directory, material, "Base Color")
        assert all(abs(value - expected) < 0.005 for value in observed), (color_space, expected, observed)
        print("CYCLES_COLORSPACE", color_space, observed, flush=True)
    opaque_material = {**base, "alphaMode": "opaque", "useTextureAlpha": False,
                       "textures": {"baseColor": {**texture, "file": "opaque-zero-alpha.png"}}}
    opaque_color = bake_material_socket(directory, opaque_material, "Base Color")
    assert all(abs(value - 128 / 255) < 0.005 for value in opaque_color), opaque_color
    captured_material = {**base, "alphaMode": "opaque", "useTextureAlpha": False,
                         "textures": {"baseColor": {**texture, "file": "gpu-readback.png", "invertY": True}}}
    captured_color = bake_material_socket(directory, captured_material, "Base Color")
    assert all(abs(value - expected) < 0.005 for value, expected in zip(captured_color, [1, 0, 0])), captured_color
    print("CYCLES_OPAQUE_RGB_AND_CAPTURE_ORIENTATION", opaque_color, captured_color, flush=True)


def check_hdr_world_additive_ambient(directory: Path) -> None:
    """实际路径追踪确认 HDR 环境存在时不会丢弃半球补光。"""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    image = bpy.data.images.new("ConstantHDR", width=8, height=4, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    image.pixels[:] = [0.2, 0.2, 0.2, 1] * 32
    image.filepath_raw = str(directory / "constant.exr")
    image.file_format = "OPEN_EXR"
    image.save()
    bpy.data.images.remove(image)
    source = {
        "positions": [0, 0, 0, 1, 0, 0, 0, 0, 1], "normals": [0, 1, 0] * 3, "indices": [0, 2, 1],
        "uvs": [0, 0, 1, 0, 0, 1], "key": "world-receiver",
        "worldMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "material": {"baseColor": [1, 1, 1], "alpha": 1, "alphaMode": "opaque", "metallic": 0,
                     "roughness": 1, "emissive": [0, 0, 0], "doubleSided": True},
    }
    obj = BAKE.make_mesh(source, directory, 200)
    target = bpy.data.images.new("WorldVerification", width=16, height=16, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    BAKE.attach_target([obj], target)
    scene = bpy.context.scene
    scene.cycles.samples = 128
    scene.render.bake.use_pass_color = False
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = False
    uv = obj.data.uv_layers["LightmapUV"]
    center = [sum(uv.data[index].uv[axis] for index in obj.data.polygons[0].loop_indices) / 3 for axis in range(2)]
    offset = (int(center[1] * 16) * 16 + int(center[0] * 16)) * 4
    values = []
    for ambient in (0, 0.1):
        BAKE.setup_lights({"environment": {"color": [ambient] * 3, "intensity": 2, "textureFile": "constant.exr"}, "lights": []}, directory)
        bpy.ops.object.bake(type="DIFFUSE")
        values.append(target.pixels[offset])
    assert values[0] > 0 and abs(values[1] / values[0] - 1.5) < 0.025, values
    print("CYCLES_HDR_AMBIENT_RATIO", values[1] / values[0], flush=True)


def check_actual_alpha_shadow(directory: Path) -> None:
    """用真实阴影射线证明 opaque 仍遮光，连续 blend 按透过率传播。"""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    base = {"baseColor": [1, 1, 1], "alpha": 1, "alphaMode": "opaque", "metallic": 0,
            "roughness": 1, "emissive": [0, 0, 0], "doubleSided": True}
    geometry = {
        "positions": [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2], "normals": [0, 1, 0] * 4,
        "indices": [0, 2, 1, 0, 3, 2], "uvs": [0, 0, 1, 0, 1, 1, 0, 1],
        "worldMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "key": "receiver", "material": base,
    }
    receiver = BAKE.make_mesh(geometry, directory, 300)
    matrix = geometry["worldMatrix"][:]
    matrix[13] = 1
    # 这些 alpha/visibility 正是编辑显示可能写入的值；opaque 物理模式必须完全忽略它们。
    blocker_data = {**base, "alpha": 0.15, "meshVisibility": 0.3, "useTextureAlpha": False}
    blocker = BAKE.make_mesh({**geometry, "key": "blocker", "worldMatrix": matrix, "material": blocker_data}, directory, 301)
    BAKE.setup_lights({"environment": {"color": [0, 0, 0], "intensity": 1}, "lights": [
        {"kind": "directional", "position": [0, 5, 0], "direction": [0, -1, 0],
         "color": [1, 1, 1], "intensity": 1},
    ]}, directory)
    scene = bpy.context.scene
    scene.cycles.samples = 256
    scene.render.bake.use_pass_color = False
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = False
    target = bpy.data.images.new("ShadowVerification", width=16, height=16, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    BAKE.attach_target([receiver], target)
    uv = receiver.data.uv_layers["LightmapUV"]
    center = [sum(uv.data[index].uv[axis] for index in receiver.data.polygons[0].loop_indices) / 3 for axis in range(2)]
    offset = (int(center[1] * 16) * 16 + int(center[0] * 16)) * 4
    blocker.hide_render = True
    bpy.ops.object.bake(type="DIFFUSE")
    clear = target.pixels[offset]
    blocker.hide_render = False
    bpy.ops.object.bake(type="DIFFUSE")
    opaque = target.pixels[offset]
    blocker.data.materials[0] = BAKE.make_material(
        {**blocker_data, "alphaMode": "blend", "alpha": 0.25, "meshVisibility": 1}, directory, "ContinuousBlend")
    bpy.ops.object.bake(type="DIFFUSE")
    blend = target.pixels[offset]
    assert clear > 0 and opaque < clear * 0.02, (clear, opaque)
    assert abs(blend / clear - 0.75) < 0.06, (clear, blend, blend / clear)
    print("CYCLES_PHYSICAL_ALPHA_SHADOW", {"opaque": opaque / clear, "blend": blend / clear}, flush=True)


with tempfile.TemporaryDirectory(prefix="cycles-material-test-") as output:
    check_rgbm(Path(output))
    check_textures_and_geometry(Path(output))
    check_alpha_modes_and_color_spaces(Path(output))
    check_hdr_world_additive_ambient(Path(output))
    check_actual_alpha_shadow(Path(output))
print("CYCLES_MATERIAL_CHECKS_PASSED", flush=True)
