"""受控的 Cycles 光照烘焙入口；仅接收主进程验证并暂存的 JSON 与纹理。"""
from __future__ import annotations

import argparse
import sys as _binary_sys
from array import array
import csv
import io
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import time
from typing import Any

import bpy
from mathutils import Matrix, Vector
import numpy as np


COORDINATES = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
REVERSE_COORDINATES = COORDINATES.inverted()
PROGRESS_PREFIX = "LIGHTING_BAKE_PROGRESS "
TEXTURE_IMAGES: dict[tuple[str, str], Any] = {}
# 每面 4×4 像素，四边各留 1 像素；可单独调低批次以限制设备内存。
PROBE_IMAGE_SIZE = 1024
PROBE_BATCH_SIZE = (PROBE_IMAGE_SIZE // 6) ** 2 // 6
# 预算不可读时采用 256²；OOM 最低退至原来的 128² / 64 探针布局。
PROBE_GPU_UNKNOWN_IMAGE_SIZE = 256
PROBE_GPU_MIN_IMAGE_SIZE = 128
PROBE_GPU_RETRY_ACTIVE = False
PROBE_BATCH_DIAGNOSTICS: dict | None = None
BAKE_DEVICE_SELECTION: dict[str, Any] = {"actual": "CPU", "name": "CPU", "backend": "CPU"}



def process_peak_memory_bytes() -> int | None:
    """记录本进程观察到的峰值 RSS；平台不支持时返回 null，不伪造零。"""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                    (name, ctypes.c_size_t) for name in (
                        "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                        "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            api = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
            api.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
            if not api(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return None
            return int(counters.PeakWorkingSetSize)
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except (ImportError, OSError, AttributeError, ValueError):
        return None

def progress(phase: str, completed: int, total: int, message: str) -> None:
    print("LIGHTING_BAKE_MEMORY " + json.dumps(process_peak_memory_bytes()), flush=True)
    print(PROGRESS_PREFIX + json.dumps(
        {"phase": phase, "completed": completed, "total": total, "message": message},
        ensure_ascii=False), flush=True)


def write_json(file: Path, data: object) -> None:
    with file.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def source_path(root: Path, name: str) -> str:
    path = (root / name).resolve()
    if path.parent != root.resolve() or not path.is_file():
        raise ValueError("纹理路径超出任务目录或文件缺失。")
    return str(path)



def load_binary_geometry(source: dict, root: Path) -> None:
    """逐网格加载 Float64/Uint32 几何附件；旧版 JSON 数组仍可读取。"""
    binary = source.pop("geometryBinary", None)
    if binary is None:
        return
    if binary.get("version") != 1:
        raise ValueError("二进制几何版本无效。")
    file = Path(source_path(root, binary["file"]))
    raw = file.read_bytes()
    if len(raw) != binary.get("byteLength") or raw[:8] != b"BLGEO001":
        raise ValueError("二进制几何长度或文件头无效。")
    ranges = []
    for field in ("positions", "normals", "indices", "uvs", "uvs2", "colors", "tangents"):
        attribute = binary.get("attributes", {}).get(field)
        if attribute is None:
            continue
        integer = field == "indices"
        width, expected = (4, "uint32") if integer else (8, "float64")
        start, length = attribute.get("byteOffset"), attribute.get("length")
        if (attribute.get("type") != expected or not isinstance(start, int)
                or not isinstance(length, int) or start < 8 or start % width or length < 0
                or start + length * width > len(raw)
                or any(start < end and start + length * width > begin for begin, end in ranges)):
            raise ValueError("二进制几何属性范围无效。")
        ranges.append((start, start + length * width))
        values = array("I" if integer else "d")
        if values.itemsize != width:
            raise ValueError("当前 Python 数值类型不支持烘焙二进制合同。")
        values.frombytes(memoryview(raw)[start:start + length * width])
        if _binary_sys.byteorder != "little":
            values.byteswap()
        if not integer and any(not math.isfinite(value) for value in values):
            raise ValueError("二进制几何包含非有限数值。")
        source[field] = values

def vector(values: list[float]) -> Vector:
    return COORDINATES.to_3x3() @ Vector(values)


def texture_nodes(material: Any, entry: dict, root: Path, color: bool) -> Any:
    nodes, links = material.node_tree.nodes, material.node_tree.links
    filename = source_path(root, entry["file"])
    color_space = entry.get("colorSpace", "srgb") if color else "linear"
    if color_space not in ("srgb", "linear"):
        raise ValueError("不支持的材质纹理颜色空间。")
    image_key = (filename, color_space)
    image = TEXTURE_IMAGES.get(image_key)
    if image is None:
        image = bpy.data.images.load(filename, check_existing=False)
        image.colorspace_settings.name = "sRGB" if color_space == "srgb" else "Non-Color"
        TEXTURE_IMAGES[image_key] = image
    # 原材质 RGB 与 alpha 分别参与颜色和透明度，禁止 Blender 按连接状态预乘颜色。
    image.alpha_mode = "CHANNEL_PACKED"
    node = nodes.new("ShaderNodeTexImage")
    node.image = image
    wrap_u, wrap_v = entry.get("wrapU", 1), entry.get("wrapV", 1)
    if wrap_u != wrap_v:
        raise ValueError("Cycles 暂不支持 U/V 不同的纹理寻址方式，请统一后再烘焙。")
    node.extension = {0: "EXTEND", 1: "REPEAT", 2: "MIRROR"}.get(wrap_u, "REPEAT")
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "SourceUV2" if entry["coordinatesIndex"] else "SourceUV"
    mapping = nodes.new("ShaderNodeMapping")
    mapping.vector_type = "POINT"
    mapping.inputs["Scale"].default_value = (entry["uScale"], entry["vScale"], 1)
    mapping.inputs["Rotation"].default_value[2] = entry["wAng"]
    mapping.inputs["Location"].default_value = (entry["uOffset"], entry["vOffset"], 0)
    center_u, center_v = entry.get("uRotationCenter", 0.5), entry.get("vRotationCenter", 0.5)
    # Babylon 默认先缩放再绕指定中心旋转；显式节点避免默认为原点旋转。
    if entry["wAng"]:
        center = nodes.new("ShaderNodeVectorMath")
        center.operation = "SUBTRACT"
        center.inputs[1].default_value = (center_u, center_v, 0)
        links.new(uv.outputs["UV"], center.inputs[0])
        links.new(center.outputs[0], mapping.inputs["Vector"])
        mapping.inputs["Location"].default_value = (
            entry["uOffset"] + center_u * entry["uScale"], entry["vOffset"] + center_v * entry["vScale"], 0)
    else:
        links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    transformed = mapping.outputs["Vector"]
    if "uvTransform" in entry:
        coefficients = entry["uvTransform"]
        split = nodes.new("ShaderNodeSeparateXYZ")
        homogeneous = nodes.new("ShaderNodeCombineXYZ")
        links.new(uv.outputs["UV"], split.inputs[0])
        links.new(split.outputs["X"], homogeneous.inputs["X"])
        links.new(split.outputs["Y"], homogeneous.inputs["Y"])
        homogeneous.inputs["Z"].default_value = 1
        combined = nodes.new("ShaderNodeCombineXYZ")
        for axis, row in (("X", coefficients[:3]), ("Y", coefficients[3:])):
            dot = nodes.new("ShaderNodeVectorMath")
            dot.operation = "DOT_PRODUCT"
            dot.inputs[1].default_value = row
            links.new(homogeneous.outputs[0], dot.inputs[0])
            links.new(dot.outputs["Value"], combined.inputs[axis])
        transformed = combined.outputs[0]
    if entry.get("invertY", False):
        flip = nodes.new("ShaderNodeMapping")
        flip.inputs["Scale"].default_value = (1, -1, 1)
        flip.inputs["Location"].default_value = (0, 1, 0)
        links.new(transformed, flip.inputs["Vector"])
        links.new(flip.outputs["Vector"], node.inputs["Vector"])
    else:
        links.new(transformed, node.inputs["Vector"])
    return node


def configure_material_alpha(material: Any, data: dict) -> None:
    """先汇总真实 alpha 因子再做 mask，编辑器 ghost opacity 不进入此契约。"""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    mode = data.get("alphaMode", "blend" if data["alpha"] < 1 else "opaque")
    if mode not in ("opaque", "mask", "blend", "mask-blend"):
        raise ValueError("不支持的材质透明模式。")
    shader.inputs["Alpha"].default_value = 1
    base = nodes.new("ShaderNodeMath")
    base.name = "LightingAlphaMesh"
    base.operation = "MULTIPLY"
    base.inputs[0].default_value = data["alpha"]
    base.inputs[1].default_value = data.get("meshVisibility", 1)
    texture = nodes.new("ShaderNodeMath")
    texture.name = "LightingAlphaTexture"
    texture.operation = "MULTIPLY"
    texture.inputs[1].default_value = 1
    links.new(base.outputs[0], texture.inputs[0])
    vertex = nodes.new("ShaderNodeMath")
    vertex.name = "LightingAlphaVertex"
    vertex.operation = "MULTIPLY"
    vertex.inputs[1].default_value = 1
    links.new(texture.outputs[0], vertex.inputs[0])
    if mode == "opaque":
        return
    result = vertex.outputs[0]
    if mode in ("mask", "mask-blend"):
        below = nodes.new("ShaderNodeMath")
        below.operation = "LESS_THAN"
        below.inputs[1].default_value = data.get("alphaCutoff", 0.5)
        links.new(result, below.inputs[0])
        keep = nodes.new("ShaderNodeMath")
        keep.operation = "SUBTRACT"
        keep.inputs[0].default_value = 1
        links.new(below.outputs[0], keep.inputs[1])
        if mode == "mask-blend":
            retained = nodes.new("ShaderNodeMath")
            retained.operation = "MULTIPLY"
            links.new(result, retained.inputs[0])
            links.new(keep.outputs[0], retained.inputs[1])
            result = retained.outputs[0]
        else:
            result = keep.outputs[0]
    links.new(result, shader.inputs["Alpha"])


def make_material(data: dict, root: Path, name: str) -> Any:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*data["baseColor"], 1)
    shader.inputs["Metallic"].default_value = data["metallic"]
    shader.inputs["Roughness"].default_value = data["roughness"]
    shader.inputs["Emission Color"].default_value = (*data["emissive"], 1)
    shader.inputs["Emission Strength"].default_value = 1
    configure_material_alpha(material, data)
    for kind, entry in data.get("textures", {}).items():
        tex = texture_nodes(material, entry, root, kind in ("baseColor", "emissive"))
        if kind in ("baseColor", "emissive"):
            multiply = nodes.new("ShaderNodeMixRGB")
            multiply.blend_type = "MULTIPLY"
            multiply.inputs[0].default_value = 1
            multiply.inputs[2].default_value = (
                *(value * entry["level"] for value in data["baseColor" if kind == "baseColor" else "emissive"]), 1)
            links.new(tex.outputs["Color"], multiply.inputs[1])
            links.new(multiply.outputs[0], shader.inputs["Base Color" if kind == "baseColor" else "Emission Color"])
            if kind == "baseColor" and data.get("useTextureAlpha", False):
                links.new(tex.outputs["Alpha"], nodes.get("LightingAlphaTexture").inputs[1])
        elif kind == "metallicRoughness":
            separate = nodes.new("ShaderNodeSeparateColor")
            links.new(tex.outputs["Color"], separate.inputs[0])
            for output, target, factor in (("Green", "Roughness", "roughness"), ("Blue", "Metallic", "metallic")):
                multiply = nodes.new("ShaderNodeMath")
                multiply.operation = "MULTIPLY"
                multiply.inputs[1].default_value = data[factor] * entry["level"]
                links.new(separate.outputs[output], multiply.inputs[0])
                links.new(multiply.outputs[0], shader.inputs[target])
        elif kind == "normal":
            normal = nodes.new("ShaderNodeNormalMap")
            normal.uv_map = "SourceUV2" if entry["coordinatesIndex"] else "SourceUV"
            normal.inputs["Strength"].default_value = entry["level"]
            source = tex.outputs["Color"]
            if data.get("invertNormalMapX") or data.get("invertNormalMapY"):
                split = nodes.new("ShaderNodeSeparateColor")
                combine = nodes.new("ShaderNodeCombineColor")
                links.new(source, split.inputs[0])
                for channel, flag in (("Red", "invertNormalMapX"), ("Green", "invertNormalMapY"), ("Blue", "")):
                    output = split.outputs[channel]
                    if data.get(flag):
                        inverse = nodes.new("ShaderNodeMath")
                        inverse.operation = "SUBTRACT"
                        inverse.inputs[0].default_value = 1
                        links.new(output, inverse.inputs[1])
                        output = inverse.outputs[0]
                    links.new(output, combine.inputs[channel])
                source = combine.outputs[0]
            links.new(source, normal.inputs["Color"])
            links.new(normal.outputs["Normal"], shader.inputs["Normal"])
        elif kind == "occlusion":
            # AO 是最终材质的局部遮蔽项；不再次乘进物理反弹，避免重复遮黑。
            pass
    if not data["doubleSided"]:
        geometry = nodes.new("ShaderNodeNewGeometry")
        transparent = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        links.new(geometry.outputs["Backfacing"], mix.inputs[0])
        links.new(shader.outputs[0], mix.inputs[1])
        links.new(transparent.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], nodes.get("Material Output").inputs["Surface"])
    return material


def activate(objects: list[Any]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def apply_vertex_colors(obj: Any, source: dict) -> None:
    colors = obj.data.color_attributes.new(name="SourceColors", type="FLOAT_COLOR", domain="POINT")
    for index, entry in enumerate(colors.data):
        entry.color = source["colors"][index * 4:index * 4 + 4]
    material = obj.data.materials[0]
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    vertex = nodes.new("ShaderNodeVertexColor")
    vertex.layer_name = "SourceColors"
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    base = shader.inputs["Base Color"]
    if base.is_linked:
        links.new(base.links[0].from_socket, multiply.inputs[1])
    else:
        multiply.inputs[1].default_value = base.default_value
    links.new(vertex.outputs["Color"], multiply.inputs[2])
    links.new(multiply.outputs[0], base)
    if source["material"].get("useVertexAlpha", False):
        # 顶点 alpha 必须在裁剪之前参与乘积；mask 存活后才恢复到完全不透明。
        links.new(vertex.outputs["Alpha"], nodes.get("LightingAlphaVertex").inputs[1])


def make_mesh(data: dict, root: Path, index: int) -> Any:
    positions = data["positions"]
    vertices = [vector(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    normals = [vector(data["normals"][i:i + 3]) for i in range(0, len(data["normals"]), 3)]
    indices = data["indices"]
    faces, flipped_faces = [], []
    for offset in range(0, len(indices), 3):
        first, second, third = indices[offset:offset + 3]
        geometric_normal = (vertices[second] - vertices[first]).cross(vertices[third] - vertices[first])
        authored_normal = normals[first] + normals[second] + normals[third]
        # Babylon 左手绕序与 glTF/自定义几何的绕序可能不同。坐标反射之后按实际法线
        # 确定 Cycles 的正面，不能再无条件翻转，否则单面材质会把整个模型当成背面。
        flipped = geometric_normal.dot(authored_normal) < 0
        faces.append((first, third, second) if flipped else (first, second, third))
        flipped_faces.append(int(flipped))
    mesh = bpy.data.meshes.new(f"Mesh-{index}")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for source, name in (("uvs", "SourceUV"), ("uvs2", "SourceUV2")):
        if source in data:
            layer = mesh.uv_layers.new(name=name)
            for loop in mesh.loops:
                layer.data[loop.index].uv = data[source][loop.vertex_index * 2:loop.vertex_index * 2 + 2]
    mesh.normals_split_custom_set_from_vertices(normals)
    obj = bpy.data.objects.new(f"Object-{index}", mesh)
    bpy.context.collection.objects.link(obj)
    values = data["worldMatrix"]
    matrix = Matrix(tuple(tuple(values[column * 4 + row] for column in range(4)) for row in range(4)))
    obj.matrix_world = COORDINATES @ matrix @ REVERSE_COORDINATES
    obj.data.materials.append(make_material(data["material"], root, f"Material-{index}"))
    if "colors" in data:
        apply_vertex_colors(obj, data)
    obj["input_index"] = index
    obj["source_winding_flipped"] = flipped_faces
    activate([obj])
    uv = mesh.uv_layers.new(name="LightmapUV")
    mesh.uv_layers.active = uv
    # 展开使用真实世界线性尺度；原始局部坐标与全部属性仍原样导出。
    world_linear = obj.matrix_world.to_3x3()
    for vertex, original in zip(mesh.vertices, vertices):
        vertex.co = world_linear @ original
    mesh.update()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02, area_weight=1.0,
                             correct_aspect=False, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    for vertex, original in zip(mesh.vertices, vertices):
        vertex.co = original
    mesh.update()
    mesh.normals_split_custom_set_from_vertices(normals)
    return obj


def world_area(obj: Any) -> float:
    mesh = obj.data
    transform = obj.matrix_world.to_3x3()
    # 先求局部边向量再变换，避免远离世界原点时单精度平移抵消有效面积。
    return sum(((transform @ (mesh.vertices[face.vertices[1]].co - mesh.vertices[face.vertices[0]].co)).cross(
        transform @ (mesh.vertices[face.vertices[2]].co - mesh.vertices[face.vertices[0]].co))).length / 2
        for face in mesh.polygons)


def triangle_area(triangle: tuple[tuple[float, ...], ...]) -> float:
    first, second, third = triangle
    ab = tuple(second[axis] - first[axis] for axis in range(3))
    ac = tuple(third[axis] - first[axis] for axis in range(3))
    return math.sqrt(sum(value * value for value in (
        ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]))) / 2


def clip_polygon(vertices: tuple[tuple[float, ...], ...], axis: int,
                 plane: float, keep_low: bool) -> list[tuple[float, ...]]:
    """裁切顶点携带世界坐标和全部原始属性；新角点始终做相同的线性插值。"""
    result = []
    previous = vertices[-1]
    previous_inside = previous[axis] <= plane if keep_low else previous[axis] >= plane
    for current in vertices:
        current_inside = current[axis] <= plane if keep_low else current[axis] >= plane
        if previous_inside != current_inside:
            # 共享边的两种绕序必须使用相同运算顺序，避免舍入差异制造裂缝和额外 UV 岛。
            first, second = sorted((previous, current))
            amount = (plane - first[axis]) / (second[axis] - first[axis])
            intersection = list(a + (b - a) * amount for a, b in zip(first, second))
            intersection[axis] = plane
            result.append(tuple(intersection))
        if current_inside:
            result.append(current)
        previous, previous_inside = current, current_inside
    return result


def split_triangles(triangles: list[tuple[tuple[float, ...], ...]], axis: int,
                    plane: float) -> tuple[list, list]:
    halves: tuple[list, list] = ([], [])
    for triangle in triangles:
        low, high = min(vertex[axis] for vertex in triangle), max(vertex[axis] for vertex in triangle)
        if high <= plane:
            halves[0].append(triangle)
        elif low >= plane:
            halves[1].append(triangle)
        elif triangle_area(triangle) == 0:
            # 原始退化面仍保留一次；只有裁切新生成的零面积扇形可忽略。
            halves[int(sum(vertex[axis] for vertex in triangle) / 3 > plane)].append(triangle)
        else:
            for side, keep_low in enumerate((True, False)):
                polygon = clip_polygon(triangle, axis, plane, keep_low)
                for index in range(1, len(polygon) - 1):
                    face = (polygon[0], polygon[index], polygon[index + 1])
                    if triangle_area(face) > 64 * math.ulp(triangle_area(triangle)):
                        halves[side].append(face)
    return halves


def partition_receiver(source: dict, size: int, density: float, maximum_area: float | None = None) -> list[dict]:
    """把超页接收面按世界空间裁成完整二叉叶集，不改原实体、材质或采样密度。"""
    base_key, separator, parent_path = source["key"].rpartition("/tile:")
    if not separator or not parent_path or not set(parent_path) <= {"0", "1"}:
        base_key, parent_path = source["key"], ""
    fields = [(name, width) for name, width in (
        ("positions", 3), ("normals", 3), ("uvs", 2), ("uvs2", 2),
        ("colors", 4), ("tangents", 4)) if name in source]
    matrix = source["worldMatrix"]
    vertices = []
    for index in range(len(source["positions"]) // 3):
        local = source["positions"][index * 3:index * 3 + 3]
        world = tuple(sum(matrix[column * 4 + row] * local[column] for column in range(3))
                      + matrix[12 + row] for row in range(3))
        attributes = tuple(value for name, width in fields
                           for value in source[name][index * width:index * width + width])
        vertices.append(world + attributes)
    triangles = [tuple(vertices[index] for index in source["indices"][start:start + 3])
                 for start in range(0, len(source["indices"]), 3)]
    original_area = sum(triangle_area(face) for face in triangles)
    # Blender 顶点存储为单精度；预留微小数值余量，防止恰好满页在转换后超出一像素。
    capacity = ((size - 8) / density) ** 2 * (1 - 1e-6)
    if maximum_area is not None:
        capacity = min(capacity, maximum_area)
    if original_area <= capacity:
        return [source]
    leaves: list[tuple[str, list]] = []

    def divide(faces: list, area: float, path: str) -> None:
        if area <= capacity:
            leaves.append((path, faces))
            return
        if len(path) + len(parent_path) >= 64:
            raise ValueError(f"{source['name']} 空间切分超过安全深度；未丢弃几何或降低贴图密度。")
        positive_vertices = [vertex for face in faces if triangle_area(face) > 0 for vertex in face]
        bounds = [(min(vertex[axis] for vertex in positive_vertices),
                   max(vertex[axis] for vertex in positive_vertices)) for axis in range(3)]
        page_count = math.ceil(area / capacity)
        left_pages = page_count // 2
        target = area * left_pages / page_count
        selected = None
        for axis in sorted(range(3), key=lambda value: bounds[value][1] - bounds[value][0], reverse=True):
            lower, upper = bounds[axis]
            if upper <= lower:
                continue
            plane = lower + (upper - lower) * left_pages / page_count
            for _ in range(24):
                left, right = split_triangles(faces, axis, plane)
                left_area, right_area = (sum(triangle_area(face) for face in half) for half in (left, right))
                if left_area > 0 and right_area > 0:
                    candidate = (left, right, left_area, right_area)
                    if selected is None or abs(left_area - target) < abs(selected[2] - target):
                        selected = candidate
                    if math.ceil(left_area / capacity) + math.ceil(right_area / capacity) <= page_count:
                        break
                if left_area < target:
                    lower = plane
                else:
                    upper = plane
                updated = lower + (upper - lower) / 2
                if updated == plane:
                    break
                plane = updated
            if selected is not None:
                break
        if selected is None:
            raise ValueError(f"{source['name']} 无法生成非空空间切片；未丢弃几何或降低贴图密度。")
        left, right, left_area, right_area = selected
        # 仅在两侧都有正面积时添加 0/1，确保服务端可验证完整二叉覆盖。
        divide(left, left_area, path + "0")
        divide(right, right_area, path + "1")

    divide(triangles, original_area, "")
    final_area = sum(triangle_area(face) for _, faces in leaves for face in faces)
    if not math.isclose(final_area, original_area, rel_tol=1e-8, abs_tol=1e-8):
        raise ValueError(f"{source['name']} 空间切分面积校验失败；未提交不完整几何。")
    result = []
    for path, faces in leaves:
        key = base_key + "/tile:" + parent_path + path
        item = {**source, "key": key, "indices": []}
        for name, _ in fields:
            item[name] = []
        vertex_indices = {}
        for face in faces:
            for vertex in face:
                attributes = vertex[3:]
                if attributes not in vertex_indices:
                    vertex_indices[attributes] = len(vertex_indices)
                    offset = 0
                    for name, width in fields:
                        item[name].extend(attributes[offset:offset + width])
                        offset += width
                item["indices"].append(vertex_indices[attributes])
        result.append(item)
    return result


def partition_receivers(meshes: list[dict], settings: dict) -> list[dict]:
    size, density = settings["atlasSize"], settings["texelsPerMeter"]
    budget = settings["maxTextureMiB"] * 1024 * 1024
    receiver_area = 0.0
    for source in meshes:
        if not source.get("receiver", True):
            continue
        matrix, positions, indices = source["worldMatrix"], source["positions"], source["indices"]
        for offset in range(0, len(indices), 3):
            points = [positions[index * 3:index * 3 + 3] for index in indices[offset:offset + 3]]
            edges = [tuple(sum(matrix[column * 4 + row] * (point[column] - points[0][column])
                               for column in range(3)) for row in range(3)) for point in points[1:]]
            receiver_area += triangle_area(((0, 0, 0), *edges))
    if receiver_area * density * density * 4 > budget:
        raise ValueError("光照图集超过纹理预算；没有丢弃对象或自动降低贴图密度。")
    result = []
    for source in meshes:
        if source.get("receiver", True):
            parts = partition_receiver(source, size, density)
            result.extend(parts)
        else:
            result.append(source)
    return result


class LightmapUvError(ValueError):
    """真实正面积面缺少可逆 UV；只能修复 UV 后重新严格验证。"""


def lightmap_face_world_per_uv(obj: Any, face: Any) -> float:
    mesh, transform = obj.data, obj.matrix_world.to_3x3()
    uv = mesh.uv_layers["LightmapUV"]
    first, second, third = face.loop_indices
    origin = mesh.vertices[mesh.loops[first].vertex_index].co
    local_edges = [tuple(float(mesh.vertices[mesh.loops[index].vertex_index].co[axis]) - float(origin[axis])
                         for axis in range(3)) for index in (second, third)]
    # 仿射变换不会使严格共线面产生面积；局部双精度叉积避免单精度矩阵的伪面积。
    u, v = local_edges
    local_cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    if all(value == 0 for value in local_cross):
        return 0.0
    edges = [transform @ Vector(edge) for edge in local_edges]
    a, b = (uv.data[index].uv - uv.data[first].uv for index in (second, third))
    determinant = a.x * b.y - a.y * b.x
    if edges[0].cross(edges[1]).length == 0:
        return 0.0
    if abs(determinant) < 1e-20:
        raise LightmapUvError(f"{obj.name} 有正面积三角面未获得有效光照 UV。")
    derivative_u = [(edges[0][axis] * b.y - edges[1][axis] * a.y) / determinant for axis in range(3)]
    derivative_v = [(edges[1][axis] * a.x - edges[0][axis] * b.x) / determinant for axis in range(3)]
    uu = sum(value * value for value in derivative_u)
    vv = sum(value * value for value in derivative_v)
    uv_dot = sum(left * right for left, right in zip(derivative_u, derivative_v))
    largest_eigenvalue = (uu + vv + math.sqrt((uu - vv) ** 2 + 4 * uv_dot * uv_dot)) / 2
    return math.sqrt(largest_eigenvalue)


def lightmap_metrics(obj: Any, density: float) -> tuple[int, int, float, float, float]:
    """按 UV→世界 Jacobian 最大奇异值保证任意方向的实际采样密度。"""
    uv = obj.data.uv_layers["LightmapUV"]
    minimum_u = min(entry.uv.x for entry in uv.data)
    minimum_v = min(entry.uv.y for entry in uv.data)
    maximum_u = max(entry.uv.x for entry in uv.data)
    maximum_v = max(entry.uv.y for entry in uv.data)
    world_per_uv = max((lightmap_face_world_per_uv(obj, face) for face in obj.data.polygons), default=0)
    scale = world_per_uv * density * (1 + 1e-4)
    return (max(16, math.ceil((maximum_u - minimum_u) * scale) + 8),
            max(16, math.ceil((maximum_v - minimum_v) * scale) + 8), scale, minimum_u, minimum_v)


def repair_lightmap_uvs(obj: Any, density: float) -> int:
    """仅为 SmartProject 量化塌缩的正面积面增建独立图块，不改原几何或材质 UV。"""
    mesh, transform = obj.data, obj.matrix_world.to_3x3()
    uv = mesh.uv_layers["LightmapUV"]
    invalid, world_per_uv = [], 0.0
    for face in mesh.polygons:
        try:
            world_per_uv = max(world_per_uv, lightmap_face_world_per_uv(obj, face))
        except LightmapUvError:
            invalid.append(face)
    if not invalid:
        return 0
    # 统一成世界米制 UV 后追加图块，原有效岛的采样密度和相对位置保持等价。
    unit = world_per_uv if world_per_uv > 0 else 1.0
    for entry in uv.data:
        entry.uv = (entry.uv.x * unit, entry.uv.y * unit)
    minimum_u = min(entry.uv.x for entry in uv.data)
    maximum_u = max(entry.uv.x for entry in uv.data)
    maximum_v = max(entry.uv.y for entry in uv.data)
    precision = max(1.0, abs(minimum_u), abs(maximum_u), abs(maximum_v)) * 2 ** -20
    minimum_height = max(1 / density, precision)
    margin = max(2 / density, precision)
    charts = []
    for face in invalid:
        loops = list(face.loop_indices)
        origin = mesh.vertices[mesh.loops[loops[0]].vertex_index].co
        points = [Vector((0, 0, 0))] + [transform @ (mesh.vertices[mesh.loops[index].vertex_index].co - origin)
                                      for index in loops[1:]]
        first, second = max(((0, 1), (0, 2), (1, 2)), key=lambda pair: (points[pair[1]] - points[pair[0]]).length_squared)
        third = 3 - first - second
        edge, offset = points[second] - points[first], points[third] - points[first]
        length = edge.length
        if length <= 0:
            raise LightmapUvError(f"{obj.name} 无法为正面积细面建立稳定光照 UV。")
        projection = offset.dot(edge) / length
        height = max(edge.cross(offset).length / length, minimum_height)
        coordinates = [None, None, None]
        coordinates[first], coordinates[second], coordinates[third] = (0, 0), (length, 0), (projection, height)
        low_u = min(value[0] for value in coordinates)
        width = max(value[0] for value in coordinates) - low_u
        charts.append((loops, coordinates, low_u, width, height))
    row_width = max(maximum_u - minimum_u, max(chart[3] for chart in charts))
    cursor_x, cursor_y, row_height = minimum_u, maximum_v + margin, 0.0
    for loops, coordinates, low_u, width, height in charts:
        if cursor_x > minimum_u and cursor_x + width > minimum_u + row_width:
            cursor_x, cursor_y, row_height = minimum_u, cursor_y + row_height + margin, 0.0
        for loop, coordinate in zip(loops, coordinates):
            uv.data[loop].uv = (cursor_x + coordinate[0] - low_u, cursor_y + coordinate[1])
        cursor_x += width + margin
        row_height = max(row_height, height)
    mesh.update()
    obj["lighting_uv_repair_count"] = len(invalid)
    return len(invalid)


def prepare_meshes(meshes: list[dict], root: Path, settings: dict) -> tuple[list[dict], list[Any]]:
    """对展开后仍超页的长条/多岛网格继续切分，直到真实密度能装入单页。"""
    size, density = settings["atlasSize"], settings["texelsPerMeter"]
    pending = list(reversed(partition_receivers(meshes, settings)))
    sources, objects = [], []
    while pending:
        source = pending.pop()
        obj = make_mesh(source, root, len(objects))
        try:
            width, height, _, _, _ = lightmap_metrics(obj, density) if source.get("receiver", True) else (0, 0, 0, 0, 0)
        except LightmapUvError:
            repair_lightmap_uvs(obj, density)
            # 修复后仍执行相同严格校验；失败时不能跳面或降低目标密度。
            width, height, _, _, _ = lightmap_metrics(obj, density)
        if source.get("receiver", True) and max(width, height) > size:
            maximum_area = world_area(obj) * ((size - 8) / (max(width, height) - 8)) ** 2 * 0.9
            parts = partition_receiver(source, size, density, maximum_area)
            if len(parts) < 2:
                raise ValueError(f"{source['name']} 无法保持目标采样密度并完成空间切分。")
            mesh, materials = obj.data, list(obj.data.materials)
            bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.meshes.remove(mesh)
            for material in materials:
                bpy.data.materials.remove(material)
            pending.extend(reversed(parts))
        else:
            sources.append(source)
            objects.append(obj)
        progress("unwrap", len(sources), len(sources) + len(pending), "正在按世界尺度生成独立光照 UV")
    return sources, objects


def pack_atlases(objects: list[Any], size: int, density: float, budget: int) -> list[list[Any]]:
    metrics = {obj.name: lightmap_metrics(obj, density) for obj in objects}
    ordered = sorted(objects, key=lambda obj: metrics[obj.name][1], reverse=True)
    pages: list[list[Any]] = []
    placements = []
    cursor_x = cursor_y = row_height = 0
    for obj in ordered:
        width, height, scale, minimum_u, minimum_v = metrics[obj.name]
        if max(width, height) > size:
            raise ValueError(f"{obj.name} 切分后仍需要 {width}×{height} 像素图块，超过图集 {size}；未降低贴图密度。")
        if not pages or cursor_y + height > size:
            pages.append([])
            cursor_x = cursor_y = row_height = 0
        if cursor_x + width > size:
            cursor_x = 0
            cursor_y += row_height
            row_height = 0
            if cursor_y + height > size:
                pages.append([])
                cursor_y = 0
        placements.append((obj, cursor_x, cursor_y, scale, minimum_u, minimum_v, len(pages) - 1))
        pages[-1].append(obj)
        cursor_x += width
        row_height = max(row_height, height)
    required_bytes = len(pages) * size * size * 4
    if required_bytes > budget:
        raise ValueError(f"光照图集超过纹理预算：需要 {len(pages)} 张图集、{required_bytes / 1048576:.2f} MiB，"
                         f"当前预算 {budget / 1048576:.2f} MiB；没有丢弃对象或自动降低贴图密度。")
    for obj, x, y, scale, minimum_u, minimum_v, atlas in placements:
        for entry in obj.data.uv_layers["LightmapUV"].data:
            entry.uv = ((x + 4 + (entry.uv.x - minimum_u) * scale) / size,
                        (y + 4 + (entry.uv.y - minimum_v) * scale) / size)
        obj["atlas"] = atlas
    return pages


def configure_light_range(light: Any, distance: float, falloff: str = "gltf") -> None:
    if falloff == "physical" or (distance <= 0 and falloff != "standard"):
        return
    light.use_nodes = True
    nodes, links = light.node_tree.nodes, light.node_tree.links
    if distance <= 0:
        # Babylon 无界 standard 不随距离变暗，仍须抵消 Cycles 点光固有的平方反比。
        constant = nodes.new("ShaderNodeLightFalloff")
        constant.inputs["Strength"].default_value = 1
        links.new(constant.outputs["Constant"], nodes.get("Emission").inputs["Strength"])
        return
    rays = nodes.new("ShaderNodeLightPath")
    divide = nodes.new("ShaderNodeMath")
    divide.operation = "DIVIDE"
    divide.inputs[1].default_value = distance
    links.new(rays.outputs["Ray Length"], divide.inputs[0])
    value = divide.outputs[0]
    if falloff != "standard":
        power = nodes.new("ShaderNodeMath")
        power.operation = "POWER"
        power.inputs[1].default_value = 4
        links.new(value, power.inputs[0])
        value = power.outputs[0]
    subtract = nodes.new("ShaderNodeMath")
    subtract.operation = "SUBTRACT"
    subtract.inputs[0].default_value = 1
    links.new(value, subtract.inputs[1])
    clamp = nodes.new("ShaderNodeMath")
    clamp.operation = "MAXIMUM"
    clamp.inputs[1].default_value = 0
    links.new(subtract.outputs[0], clamp.inputs[0])
    if falloff == "standard":
        constant = nodes.new("ShaderNodeLightFalloff")
        links.new(clamp.outputs[0], constant.inputs["Strength"])
        links.new(constant.outputs["Constant"], nodes.get("Emission").inputs["Strength"])
    else:
        square = nodes.new("ShaderNodeMath")
        square.operation = "MULTIPLY"
        links.new(clamp.outputs[0], square.inputs[0])
        links.new(clamp.outputs[0], square.inputs[1])
        # glTF 窗函数与平方反比衰减相乘；编辑器 standard 使用线性距离并抵消平方反比。
        links.new(square.outputs[0], nodes.get("Emission").inputs["Strength"])


def configure_spot_distribution(light: Any, direction: Vector, entry: dict) -> None:
    light.use_nodes = True
    nodes, links = light.node_tree.nodes, light.node_tree.links

    def math_node(operation: str, first: Any, second: Any = 0) -> Any:
        node = nodes.new("ShaderNodeMath")
        node.operation = operation
        for index, value in enumerate((first, second)):
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    geometry = nodes.new("ShaderNodeNewGeometry")
    dot = nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = direction.normalized()
    links.new(geometry.outputs["Incoming"], dot.inputs[0])
    cosine = dot.outputs["Value"]
    outer_cosine = math.cos(entry.get("angle", math.pi / 3) / 2)
    falloff = entry.get("falloff", "physical")
    if falloff == "standard":
        positive = math_node("MAXIMUM", cosine, 0)
        power = math_node("POWER", positive, entry.get("exponent", 2))
        angular = math_node("MULTIPLY", power, math_node("GREATER_THAN", cosine, outer_cosine))
    elif falloff == "gltf":
        scale = 1 / max(0.001, math.cos(entry.get("innerAngle", 0) / 2) - outer_cosine)
        ramp = math_node("MULTIPLY_ADD", cosine, scale)
        ramp.node.inputs[2].default_value = -outer_cosine * scale
        bounded = math_node("MINIMUM", math_node("MAXIMUM", ramp, 0), 1)
        angular = math_node("MULTIPLY", bounded, bounded)
    else:
        concentration = 6.64385618977 / max(0.000001, 1 - outer_cosine)
        angular = math_node("POWER", 2, math_node("MULTIPLY", math_node("SUBTRACT", cosine, 1), concentration))
    strength = nodes.get("Emission").inputs["Strength"]
    previous = strength.links[0].from_socket if strength.is_linked else strength.default_value
    links.new(math_node("MULTIPLY", previous, angular), strength)


def setup_lights(data: dict, root: Path) -> list[Any]:
    world = bpy.data.worlds.new("BakeEnvironment")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    environment = data["environment"]
    background.inputs["Color"].default_value = (*environment["color"], 1)
    background.inputs["Strength"].default_value = environment["intensity"]
    if environment.get("textureFile"):
        texture = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
        texture.image = bpy.data.images.load(source_path(root, environment["textureFile"]))
        # HDR 纹理与捕获的半球补光共同贡献环境；不能在接入 HDR 后丢掉补光基线。
        combined = world.node_tree.nodes.new("ShaderNodeVectorMath")
        combined.operation = "ADD"
        combined.inputs[1].default_value = environment["color"]
        world.node_tree.links.new(texture.outputs["Color"], combined.inputs[0])
        world.node_tree.links.new(combined.outputs["Vector"], background.inputs["Color"])
        if environment.get("rotation"):
            coordinates = world.node_tree.nodes.new("ShaderNodeTexCoord")
            mapping = world.node_tree.nodes.new("ShaderNodeMapping")
            mapping.inputs["Rotation"].default_value[2] = -environment["rotation"]
            world.node_tree.links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
            world.node_tree.links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    lights = []
    for index, entry in enumerate(data["lights"]):
        kind = {"directional": "SUN", "point": "POINT", "spot": "SPOT", "area": "AREA"}[entry["kind"]]
        # 用点光载体加显式角度函数，避免 Cycles 原生聚光软边再乘一次不同的衰减。
        light = bpy.data.lights.new(f"Light-{index}", "POINT" if kind == "SPOT" else kind)
        light.color = entry["color"]
        # Babylon 默认物理点光强度为坎德拉，Cycles 点光功率为瓦特；4π 转换保留球面总能量。
        light.energy = entry["intensity"] * (4 * math.pi if kind in ("POINT", "SPOT") else 1)
        if kind in ("POINT", "SPOT") and (entry.get("range", 0) > 0 or entry.get("falloff") == "standard"):
            configure_light_range(light, entry.get("range", 0), entry.get("falloff", "physical"))
        if kind == "SPOT":
            configure_spot_distribution(light, vector(entry["direction"]), entry)
        if kind == "AREA":
            light.shape = "RECTANGLE"
            light.size = entry.get("width", 1)
            light.size_y = entry.get("height", 1)
        obj = bpy.data.objects.new(f"LightObject-{index}", light)
        bpy.context.collection.objects.link(obj)
        obj.location = vector(entry["position"])
        direction = vector(entry["direction"])
        if direction.length:
            obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        lights.append(obj)
    return lights


def attach_target(objects: list[Any], image: Any) -> None:
    for obj in objects:
        obj.data.uv_layers.active = obj.data.uv_layers["LightmapUV"]
        obj.data.uv_layers["LightmapUV"].active_render = True
        for material in obj.data.materials:
            nodes = material.node_tree.nodes
            target = nodes.get("BakeTarget") or nodes.new("ShaderNodeTexImage")
            target.name = "BakeTarget"
            target.image = image
            nodes.active = target
    activate(objects)


def merge_irradiance_pixels(pixels: np.ndarray, ambient: np.ndarray) -> np.ndarray:
    """在 float32 缓冲内合并两遍结果，alpha 不参与光照运算。"""
    rgba = pixels.reshape(-1, 4)
    np.add(rgba[:, :3], ambient.reshape(-1, 4)[:, :3], out=rgba[:, :3])
    # 原 max(0, value) 会把 NaN（包括正负无穷相消）归零；正无穷仍须保留并在 RGBM 拒绝。
    np.fmax(rgba[:, :3], 0, out=rgba[:, :3])
    rgba[:, 3] = 1
    return pixels


def encode_rgbm_pixels(pixels: np.ndarray) -> tuple[int, np.ndarray]:
    """向量化编码；乘数保留原 Python double 精度，避免 ceil 边界跳级。"""
    rgba = pixels.reshape(-1, 4)
    rgb = rgba[:, :3]
    dynamic_range = max(1, math.ceil(float(np.max(rgb, initial=1))))
    multiplier = rgb.max(axis=1).astype(np.float64)
    multiplier /= dynamic_range
    multiplier *= 255
    np.ceil(multiplier, out=multiplier)
    multiplier /= 255
    np.maximum(multiplier, 1 / 255, out=multiplier)
    encoded = np.empty_like(rgba)
    np.divide(rgb, multiplier[:, None] * dynamic_range, out=encoded[:, :3])
    encoded[:, 3] = multiplier
    return dynamic_range, encoded.reshape(-1)


def sample_probe_irradiance(pixels: np.ndarray, size: int, count: int) -> np.ndarray:
    """读取原瓦片中心的 2×2；保留六面顺序与 dx/dy 求和顺序。"""
    tiles = np.arange(count * 6)
    columns = size // 6
    x = tiles % columns * 6 + 2
    y = tiles // columns * 6 + 2
    indices = (y * size + x)[:, None] + np.array([0, size, 1, size + 1])
    samples = pixels.reshape(-1, 4)[indices, :3]
    # 原实现把四个 float32 转为 Python double 后求和，不能改为 float32 均值。
    return samples.mean(axis=1, dtype=np.float64).reshape(count, 18)


def bake_irradiance(objects: list[Any], lights: list[Any], size: int, name: str) -> np.ndarray:
    scene = bpy.context.scene
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=True)
    light_visibility = [(light, light.hide_render) for light in lights]
    try:
        image.colorspace_settings.name = "Non-Color"
        attach_target(objects, image)
        scene.render.bake.use_clear = True
        scene.render.bake.margin = 3
        # 不含表面颜色，运行时继续使用原材质基础色和金属度。
        scene.render.bake.use_pass_color = False
        scene.render.bake.use_pass_direct = False
        scene.render.bake.use_pass_indirect = True
        bake_diffuse()
        pixels = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        for light in lights:
            light.hide_render = True
        scene.render.bake.use_pass_direct = True
        scene.render.bake.use_pass_indirect = False
        bake_diffuse()
        ambient = np.empty_like(pixels)
        image.pixels.foreach_get(ambient)
        return merge_irradiance_pixels(pixels, ambient)
    finally:
        # 第二遍 OOM 后也必须恢复灯光并释放旧图，缩批才会降低下一次峰值。
        for light, hidden in light_visibility:
            light.hide_render = hidden
        bpy.data.images.remove(image)


def save_rgbm(pixels: np.ndarray, size: int, destination: Path) -> float:
    dynamic_range, encoded = encode_rgbm_pixels(pixels)
    image = bpy.data.images.new(destination.stem, width=size, height=size, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.alpha_mode = "CHANNEL_PACKED"
    image.pixels.foreach_set(encoded)
    image.filepath_raw = str(destination)
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return dynamic_range


def collect_export_geometry(obj: Any, source: dict) -> dict:
    mesh = obj.data
    result: dict[str, Any] = {"version": 2, "key": source["key"], "positions": [], "normals": [],
                             "indices": [], "uvs": [], "bakeUvs": []}
    if "uvs2" in source:
        result["uvs2"] = []
    if "colors" in source:
        result["colors"] = []
    if "tangents" in source:
        result["tangents"] = []
    channels = [(name, width) for name, width in (("positions", 3), ("normals", 3), ("uvs", 2),
                ("uvs2", 2), ("colors", 4), ("tangents", 4), ("bakeUvs", 2)) if name in result]
    channel_mask = sum(1 << index for index, name in enumerate(("uvs", "uvs2", "colors", "tangents")) if name in source)
    vertices: dict[bytes, int] = {}
    # 只合并本表面完整属性的 IEEE-754 字节；UV 岛、硬法线和正负零边界仍独立。
    flipped_faces = obj["source_winding_flipped"]
    for face in mesh.polygons:
        loops = list(face.loop_indices)
        # 恢复每个输入三角形自己的原始角点顺序；Cycles 修正只用于离线射线计算。
        if flipped_faces[face.index]:
            loops = [loops[0], loops[2], loops[1]]
        for loop_index in loops:
            loop = mesh.loops[loop_index]
            vertex = loop.vertex_index
            values = []
            for channel, width in channels:
                values.extend(mesh.uv_layers["LightmapUV"].data[loop_index].uv if channel == "bakeUvs"
                              else (0, 0) if channel == "uvs" and channel not in source
                              else source[channel][vertex * width:vertex * width + width])
            key = bytes((channel_mask,)) + struct.pack("<" + "d" * len(values), *values)
            index = vertices.get(key)
            if index is None:
                index = len(result["positions"]) // 3
                vertices[key] = index
                offset = 0
                for channel, width in channels:
                    result[channel].extend(values[offset:offset + width])
                    offset += width
            result["indices"].append(index)
    return result


def export_geometry(obj: Any, source: dict, destination: Path) -> None:
    """兼容原 JSON 导出入口；B6 逐角点 oracle 继续使用同一无损数据。"""
    write_json(destination, collect_export_geometry(obj, source))


def encode_export_geometry_binary(result: dict) -> bytes | None:
    """只有完整几何 Float32 往返字节相等才输出二进制，不能量化 CPU 拾取输入。"""
    key = result.get("key")
    # 与浏览器小头的 UTF-16 字符预算一致；切片追加的长键仍能沿用旧 JSON。
    if (result.get("version") != 2 or not isinstance(key, str) or not key or "\0" in key
            or len(key.encode("utf-16-le", errors="surrogatepass")) // 2 > 4096):
        return None
    widths = {"positions": 3, "normals": 3, "uvs": 2, "uvs2": 2, "colors": 4,
              "tangents": 4, "bakeUvs": 2, "indices": 1}
    attributes, buffers = {}, []
    for field, width in widths.items():
        if field not in result:
            continue
        values = result[field]
        if field == "indices":
            if any(not isinstance(value, int) or value < 0 or value > 0xffffffff for value in values):
                return None
            encoded = array("I", values)
        else:
            try:
                encoded = array("f", values)
            except (OverflowError, ValueError):
                return None
            if any(not math.isfinite(value) or struct.pack("<d", value) != struct.pack("<d", actual)
                   for value, actual in zip(values, encoded)):
                return None
        if encoded.itemsize != 4:
            return None
        if _binary_sys.byteorder != "little":
            encoded.byteswap()
        attributes[field] = {"type": "uint32" if field == "indices" else "float32",
                             "components": width, "count": len(values), "byteOffset": 0}
        buffers.append(encoded)
    header = {"version": 1, "geometryVersion": result["version"], "key": key,
              "vertexCount": len(result["positions"]) // 3, "indexCount": len(result["indices"]),
              "attributes": attributes}
    # 绝对偏移的位数会影响小头长度；固定点收敛后才写数据，避免头覆盖 payload。
    start = 12
    for _ in range(20):
        offset = start
        for attribute in attributes.values():
            attribute["byteOffset"] = offset
            offset += attribute["count"] * 4
        text = json.dumps(header, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        aligned = (12 + len(text) + 3) // 4 * 4
        if aligned == start:
            break
        start = aligned
    else:
        return None
    if len(text) > 65536:
        return None
    return b"BLGOUT01" + struct.pack("<I", len(text)) + text + bytes(start - 12 - len(text)) + b"".join(buffers)


def write_export_geometry(result: dict, destination_stem: Path) -> dict:
    binary = encode_export_geometry_binary(result)
    if binary is None:
        destination = destination_stem.with_suffix(".json")
        write_json(destination, result)
        return {"geometryFile": destination.name, "geometryVersion": result["version"]}
    destination = destination_stem.with_suffix(".bin")
    destination.write_bytes(binary)
    return {"geometryFile": destination.name, "geometryVersion": result["version"], "encoding": "binary-v1"}



def source_probe_bounds(meshes: list[dict]) -> dict:
    """探针范围只取已验证物理输入，不读取 UV 临时缩放留下的依赖图缓存。"""
    low, high = [math.inf] * 3, [-math.inf] * 3
    for source in meshes:
        local_low, local_high = [math.inf] * 3, [-math.inf] * 3
        for index, value in enumerate(source["positions"]):
            axis = index % 3
            local_low[axis] = min(local_low[axis], value)
            local_high[axis] = max(local_high[axis], value)
        matrix = source["worldMatrix"]
        for corner in range(8):
            point = [local_high[axis] if corner & (1 << axis) else local_low[axis] for axis in range(3)]
            for row in range(3):
                value = sum(matrix[column * 4 + row] * point[column] for column in range(3)) + matrix[12 + row]
                low[row] = min(low[row], value)
                high[row] = max(high[row], value)
    return {"min": low, "max": high}

def probe_positions(objects: list[Any], spacing: float, volumes: list[dict] | None = None,
                    input_bounds: dict | None = None) -> list[Vector]:
    active = [volume for volume in (volumes or []) if volume.get("enabled", True)]
    if active or input_bounds is not None:
        positions, keys = [], set()
        for volume in (active if active else [input_bounds]):
            low, high = volume["min"], volume["max"]
            extents = [high[axis] - low[axis] for axis in range(3)]
            counts = [max(1, math.ceil(extent / spacing)) for extent in extents]
            if not active and math.prod(counts) > 4096:
                raise ValueError("探针超过 4096 个安全预算；请增大探针间距。不会静默丢弃探针。")
            for x in range(counts[0]):
                for y in range(counts[1]):
                    for z in range(counts[2]):
                        indices = (x, y, z)
                        point = [low[axis] + (indices[axis] + 0.5) * (extents[axis] if active else max(extents[axis], 0.1)) / counts[axis]
                                 for axis in range(3)]
                        key = tuple(math.floor(value * 1e6 + 0.5) for value in point)
                        if key in keys:
                            continue
                        keys.add(key)
                        positions.append(vector(point))
                        if len(positions) > 4096:
                            raise ValueError("探针覆盖区域产生至少 4097 个独立探针，超过 4096 上限。")
        return positions
    # 兼容直接调用：按已恢复的实际顶点求范围，避免依赖缓存的 bound_box。
    coordinates = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    low = Vector(tuple(min(point[axis] for point in coordinates) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in coordinates) for axis in range(3)))
    counts = [max(1, math.ceil((high[axis] - low[axis]) / spacing)) for axis in range(3)]
    if math.prod(counts) > 4096:
        raise ValueError("探针超过 4096 个安全预算；请增大探针间距。不会静默丢弃探针。")
    return [Vector(tuple(low[axis] + (indices[axis] + 0.5) * max(high[axis] - low[axis], 0.1) / counts[axis]
                         for axis in range(3)))
            for x in range(counts[0]) for y in range(counts[1]) for z in range(counts[2])
            for indices in [(x, y, z)]]


def gpu_pci_address(identifier: str) -> tuple[int, int, int, int] | None:
    """Cycles 的设备 ID 与 nvidia-smi 的 PCI 域补零长度不同，按数值比较。"""
    match = re.search(r"(?<![0-9a-f])([0-9a-f]{4,8}):([0-9a-f]{2}):([0-9a-f]{2})(?:\.([0-7]))?(?![0-9a-f])",
                      identifier.lower())
    return tuple(int(part or "0", 16) for part in match.groups()) if match else None


def query_selected_gpu_memory(selection: dict) -> dict:
    """仅接受能对应到实际选中 GPU 的显存数据；其余后端明确使用未知预算。"""
    unknown = {"source": "unavailable", "totalBytes": None, "freeBytes": None,
               "reason": "当前 GPU 后端未提供可核验的空闲显存；使用保守 256² 探针图像。"}
    if selection.get("backend") not in ("CUDA", "OPTIX"):
        return unknown
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return {**unknown, "reason": "nvidia-smi 不可用；使用保守 256² 探针图像。"}
    try:
        result = subprocess.run(
            [executable, "--query-gpu=uuid,pci.bus_id,name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        rows = [row for row in csv.reader(io.StringIO(result.stdout), skipinitialspace=True) if len(row) == 5]
        identifier = selection.get("id", "")
        address = gpu_pci_address(identifier)
        matches = [row for row in rows if (row[0].strip() and row[0].strip() in identifier) or (
            address is not None and gpu_pci_address(row[1]) == address)]
        if not matches and address is None:
            # 同名多卡不能猜测显存属于哪张；唯一精确名称才可作为兼容兜底。
            matches = [row for row in rows if row[2].strip() == selection.get("name")]
        if len(matches) != 1:
            return {**unknown, "reason": "无法唯一对应 Cycles 选中的 GPU；使用保守 256² 探针图像。"}
        row = matches[0]
        total, free = (int(float(value.strip()) * 1024 * 1024) for value in row[3:])
        if total <= 0 or free < 0 or free > total:
            raise ValueError("显存计数无效")
        return {"source": "nvidia-smi", "deviceUuid": row[0].strip(), "totalBytes": total,
                "freeBytes": free, "reason": None}
    except (OSError, subprocess.SubprocessError, ValueError, OverflowError) as error:
        return {**unknown, "reason": f"显存查询不可用（{error}）；使用保守 256² 探针图像。"}


def probe_batch_capacity(size: int, gpu: bool) -> int:
    capacity = min(PROBE_BATCH_SIZE, (size // 6) ** 2 // 6)
    return min(capacity, 64) if gpu and size <= PROBE_GPU_MIN_IMAGE_SIZE else capacity


def probe_batch_plan() -> dict:
    """只调整探针图像/批次容量，不改每面的像素数、采样数或光照配置。"""
    gpu = bpy.context.scene.cycles.device == "GPU"
    size = PROBE_IMAGE_SIZE
    memory = {"source": "not-required", "totalBytes": None, "freeBytes": None, "reason": None}
    reason = "CPU 保持配置的探针图像与容量。"
    if gpu:
        memory = query_selected_gpu_memory(BAKE_DEVICE_SELECTION)
        if memory["freeBytes"] is None:
            size = min(size, PROBE_GPU_UNKNOWN_IMAGE_SIZE)
            reason = memory["reason"]
        else:
            # 至少预留 512 MiB 给场景/驱动，其余空闲显存仅用 1/16 估计图像预算。
            # 64 B/像素覆盖两份 ndarray、Blender 图像与设备副本；不是整场景峰值保证。
            budget = max(0, memory["freeBytes"] - 512 * 1024 * 1024) // 16
            minimum = min(PROBE_GPU_MIN_IMAGE_SIZE, size)
            while size > minimum and size * size * 64 > budget:
                size = max(minimum, size // 2)
            reason = f"按空闲显存 {memory['freeBytes']} bytes 保守选择；图像预算 {budget} bytes，OOM 时继续缩批。"
    capacity = probe_batch_capacity(size, gpu)
    if capacity < 1:
        raise ValueError("探针批次与图像尺寸必须至少容纳一个探针。")
    return {"imageSize": size, "batchSize": capacity, "gpu": gpu, "memory": memory, "reason": reason}


def smaller_probe_batch(plan: dict) -> dict | None:
    minimum = min(PROBE_GPU_MIN_IMAGE_SIZE, PROBE_IMAGE_SIZE)
    if plan["imageSize"] <= minimum:
        return None
    size = max(minimum, plan["imageSize"] // 2)
    return {**plan, "imageSize": size, "batchSize": min(plan["batchSize"], probe_batch_capacity(size, True)),
            "reason": "仅因 GPU 显存不足缩小图像与探针批次，重做当前未提交批次。"}


def bake_probe_batch(batch: list[Vector], lights: list[Any], size: int) -> np.ndarray:
    """失败批次不导出；所有临时数据块在再次分配前释放。"""
    columns = size // 6
    vertices, faces = [], []
    axes = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    # 六面顺序与原瓦片内采样位置保持不变，仅扩大同一张图的瓦片数量。
    for position in batch:
        for axis in axes:
            normal = vector(list(axis))
            tangent = normal.cross(Vector((0, 0, 1)) if abs(normal.z) < 0.9 else Vector((0, 1, 0))).normalized()
            bitangent = normal.cross(tangent)
            center = position + normal * 0.001
            offset = len(vertices)
            vertices.extend([center + tangent * a * 0.001 + bitangent * b * 0.001
                             for a, b in [(-1, -1), (1, -1), (1, 1), (-1, 1)]])
            faces.append(tuple(offset + index for index in range(4)))
    mesh = bpy.data.meshes.new("ProbeMesh")
    obj, material = None, None
    try:
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        uv = mesh.uv_layers.new(name="LightmapUV")
        for face in mesh.polygons:
            x, y = face.index % columns * 6, face.index // columns * 6
            for loop_index, (u, v) in zip(face.loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                uv.data[loop_index].uv = ((x + 1 + u * 4) / size, (y + 1 + v * 4) / size)
        obj = bpy.data.objects.new("ProbeTargets", mesh)
        bpy.context.collection.objects.link(obj)
        material = bpy.data.materials.new("ProbeDiffuse")
        material.use_nodes = True
        material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1, 1, 1, 1)
        obj.data.materials.append(material)
        pixels = bake_irradiance([obj], lights, size, "ProbeBake")
        return sample_probe_irradiance(pixels, size, len(batch))
    finally:
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        if material is not None:
            bpy.data.materials.remove(material)


def bake_probes(objects: list[Any], lights: list[Any], spacing: float, root: Path,
                positions: list[Vector] | None = None) -> int:
    global PROBE_GPU_RETRY_ACTIVE, PROBE_BATCH_DIAGNOSTICS
    positions = positions if positions is not None else probe_positions(objects, spacing)
    plan = probe_batch_plan()
    probes, start = [], 0
    report = {"version": 1, "status": "running", "device": {**BAKE_DEVICE_SELECTION,
              "actual": "GPU" if plan["gpu"] else "CPU"}, "initialPlan": plan, "oomRetries": 0, "bakeCalls": 0, "attempts": []}
    previous_retry = PROBE_GPU_RETRY_ACTIVE
    previous_diagnostics = PROBE_BATCH_DIAGNOSTICS
    PROBE_GPU_RETRY_ACTIVE = plan["gpu"]
    PROBE_BATCH_DIAGNOSTICS = report
    try:
        progress("probes", 0, len(positions), plan["reason"])
        while start < len(positions):
            batch = positions[start:start + plan["batchSize"]]
            attempt = {"start": start, "count": len(batch), "imageSize": plan["imageSize"],
                       "batchSize": plan["batchSize"], "status": "running"}
            report["attempts"].append(attempt)
            print("LIGHTING_BAKE_PROBE_BATCH " + json.dumps({"device": report["device"], **attempt}), flush=True)
            before_calls = report["bakeCalls"]
            try:
                irradiances = bake_probe_batch(batch, lights, plan["imageSize"])
            except RuntimeError as error:
                attempt.update({"status": "failed", "reason": str(error)})
                if not plan["gpu"]:
                    raise
                if not is_gpu_out_of_memory_error(error):
                    # 设备丢失等不缩批，仍保留旧服务合同中的整任务 CPU 回退。
                    if is_gpu_memory_error(error):
                        print("LIGHTING_BAKE_GPU_FALLBACK " + str(error), file=sys.stderr, flush=True)
                    raise
                reduced = smaller_probe_batch(plan)
                if reduced is None:
                    # 仅最低布局仍 OOM 时通知主进程，沿用既有整任务 CPU 回退。
                    print("LIGHTING_BAKE_GPU_FALLBACK " + str(error), file=sys.stderr, flush=True)
                    raise
                attempt["status"] = "oom-retry"
                report["oomRetries"] += 1
                plan = reduced
                progress("probes", start, len(positions), f"GPU 显存不足，缩至 {plan['imageSize']}² / {plan['batchSize']} 探针后重试。")
                continue
            finally:
                attempt["bakeCalls"] = report["bakeCalls"] - before_calls
            attempt["status"] = "completed"
            for position, irradiance in zip(batch, irradiances):
                probes.append({"position": list(REVERSE_COORDINATES.to_3x3() @ position),
                               "irradiance": irradiance.tolist()})
            start += len(batch)
            progress("probes", start, len(positions), "正在烘焙动态物体间接光探针")
        write_json(root / "probes.json", {"version": 1, "encoding": "ambient-cube", "spacing": spacing, "probes": probes})
        report["status"] = "completed"
        return len(probes)
    except BaseException as error:
        report["status"] = "cancelled" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed"
        report["reason"] = str(error)
        raise
    finally:
        PROBE_GPU_RETRY_ACTIVE = previous_retry
        PROBE_BATCH_DIAGNOSTICS = previous_diagnostics
        # 汇总同时进入已有 cycles.log；整任务 CPU 回退重写 JSON 后仍可追溯 GPU 尝试。
        print("LIGHTING_BAKE_PROBE_BATCHES " + json.dumps(report, ensure_ascii=False), flush=True)
        try:
            write_json(root / "probe-batches.json", report)
        except OSError as error:
            if report["status"] == "completed":
                raise
            print("LIGHTING_BAKE_PROBE_REPORT_ERROR " + str(error), file=sys.stderr, flush=True)



def discover_bake_devices() -> list[dict]:
    """只修改独立 factory-startup 进程内的设置，不保存用户偏好。"""
    output = [{"id": "cpu", "name": "CPU", "backend": "CPU", "type": "CPU"}]
    addon = bpy.context.preferences.addons.get("cycles")
    if addon is None:
        return output
    preferences = addon.preferences
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            preferences.compute_device_type = backend
            preferences.refresh_devices()
            for device in preferences.devices:
                if device.type != "CPU":
                    output.append({"id": device.id, "name": device.name, "backend": backend, "type": "GPU"})
        except (TypeError, ValueError, RuntimeError):
            # 未编译的后端在设置枚举时会失败，其余后端继续独立探测。
            continue
    return output


def configure_bake_device(preference: str) -> None:
    global BAKE_DEVICE_SELECTION
    requested = preference if preference in ("auto", "gpu") else "cpu"
    selection = {"requested": requested, "actual": "CPU", "name": "CPU", "backend": "CPU"}
    bpy.context.scene.cycles.device = "CPU"
    if requested != "cpu":
        devices = [device for device in discover_bake_devices() if device["type"] == "GPU"]
        if devices:
            selected = devices[0]
            preferences = bpy.context.preferences.addons["cycles"].preferences
            try:
                preferences.compute_device_type = selected["backend"]
                preferences.refresh_devices()
                for device in preferences.devices:
                    device.use = device.id == selected["id"] and device.type != "CPU"
                bpy.context.scene.cycles.device = "GPU"
                selection.update({"actual": "GPU", "id": selected["id"], "name": selected["name"], "backend": selected["backend"]})
            except (TypeError, ValueError, RuntimeError) as error:
                selection["fallbackReason"] = f"GPU 配置不可用，已回退 CPU：{error}"
        else:
            selection["fallbackReason"] = "未发现可用 GPU，已使用 CPU。"
    BAKE_DEVICE_SELECTION = selection
    print("LIGHTING_BAKE_DEVICE " + json.dumps(selection, ensure_ascii=False), flush=True)


def is_gpu_memory_error(error: Exception) -> bool:
    text = str(error).lower()
    return any(token in text for token in ("out of memory", "out of gpu memory", "out of device memory", "memory allocation",
                                                "failed to allocate", "insufficient memory", "cuda_error_out_of_memory", "hiperroroutofmemory",
                                                "cuda error", "hip error", "device lost", "invalid device", "no kernel image",
                                                "failed to create cuda", "failed to create optix"))


def is_gpu_out_of_memory_error(error: Exception) -> bool:
    """缩批只处理内存不足；无效分配与设备故障保留原服务回退分类。"""
    text = str(error).lower()
    if any(token in text for token in (
            "invalid argument", "invalid value", "invalid allocation", "invalid size", "illegal address",
            "device lost", "invalid device", "no kernel image")):
        return False
    return any(token in text for token in (
        "out of memory", "out of gpu memory", "out of device memory", "insufficient memory",
        "cuda_error_out_of_memory", "hiperroroutofmemory", "memory allocation failed", "memory allocation failure",
        "failed to allocate memory", "failed to allocate gpu memory", "failed to allocate device memory"))


def bake_diffuse() -> None:
    if PROBE_BATCH_DIAGNOSTICS is not None:
        PROBE_BATCH_DIAGNOSTICS["bakeCalls"] += 1
    try:
        bpy.ops.object.bake(type="DIFFUSE")
    except RuntimeError as error:
        if bpy.context.scene.cycles.device == "GPU" and not PROBE_GPU_RETRY_ACTIVE and is_gpu_memory_error(error):
            print("LIGHTING_BAKE_GPU_FALLBACK " + str(error), file=sys.stderr, flush=True)
        raise

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--devices", action="store_true")
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if arguments.devices:
        print("LIGHTING_BAKE_DEVICES " + json.dumps(discover_bake_devices(), ensure_ascii=False), flush=True)
        return
    if not arguments.input:
        raise ValueError("缺少烘焙输入。")
    file = Path(arguments.input).resolve()
    root = file.parent
    with file.open(encoding="utf-8") as stream:
        data = json.load(stream)
    for source in data["meshes"]:
        load_binary_geometry(source, root)
    started = time.monotonic()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    # CPU 是稳定默认值；不会借用用户当前 Blender 会话或改动其偏好配置。
    configure_bake_device(data["settings"].get("device", "cpu"))
    scene.cycles.samples = {"preview": 16, "standard": 64, "high": 256}[data["settings"]["quality"]]
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 4
    settings = data["settings"]
    input_bounds = source_probe_bounds(data["meshes"])
    data["meshes"], objects = prepare_meshes(data["meshes"], root, settings)
    lights = setup_lights(data, root)
    size = settings["atlasSize"]
    receivers = [obj for obj in objects if data["meshes"][obj["input_index"]].get("receiver", True)]
    pages = pack_atlases(receivers, size, settings["texelsPerMeter"], settings["maxTextureMiB"] * 1024 * 1024)
    # 先做全部可判定检查，避免全部图集完成后才发现探针超限。
    # UV 展开曾临时改动局部顶点；在提前预检前统一刷新恢复后的物理几何。
    bpy.context.view_layer.update()
    positions = probe_positions(objects, settings["probeSpacing"], settings.get("probeVolumes"), input_bounds)
    write_json(root / "preflight.json", {"version": 1, "atlasCount": len(pages),
                                       "probeCount": len(positions), "textureBytes": len(pages) * size * size * 4,
                                       "sourceBounds": input_bounds})
    progress("preflight", 1, 1, f"预检通过：{len(pages)} 张图集，{len(positions)} 个探针")
    atlas_results = []
    for index, page in enumerate(pages):
        progress("baking", index, len(pages), "正在烘焙间接光与环境漫反射")
        pixels = bake_irradiance(page, lights, size, f"Atlas-{index}")
        name = f"lightmap-{index}.png"
        dynamic_range = save_rgbm(pixels, size, root / name)
        atlas_results.append({"file": name, "width": size, "height": size, "encoding": "rgbm", "rgbmRange": dynamic_range})
    mesh_results = []
    for obj in receivers:
        index = obj["input_index"]
        source = data["meshes"][index]
        geometry = write_export_geometry(collect_export_geometry(obj, source), root / f"geometry-{index}")
        mesh_results.append({"key": source["key"], "entityId": source["entityId"], "nodeKey": source["nodeKey"],
                             **geometry, "atlasIndex": obj["atlas"]})
    count = bake_probes(objects, lights, settings["probeSpacing"], root, positions)
    write_json(root / "result.json", {"version": 1, "signature": data["signature"], "engineVersion": bpy.app.version_string,
                                    "atlases": atlas_results, "meshes": mesh_results, "probesFile": "probes.json",
                                    "statistics": {"meshCount": len(objects), "triangleCount": sum(len(entry["indices"]) // 3 for entry in data["meshes"]),
                                                   "atlasCount": len(pages), "probeCount": count,
                                                   "durationMs": round((time.monotonic() - started) * 1000),
                                                   "textureBytes": len(pages) * size * size * 4}})
    progress("completed", 1, 1, "光照资源生成完成，正在校验")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("LIGHTING_BAKE_ERROR " + str(error), file=sys.stderr, flush=True)
        raise
