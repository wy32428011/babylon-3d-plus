"""B9 有限 mip：真实 chart 认证、同 chart 线性 padding 和独立严格容器。

不调用 Blender、不修改 UV/几何/输入像素。主烘焙入口须在成功得到实际线性 bake
后调用；此处不通过颜色或 alpha 猜测 bake 是否成功。拒绝条件不能自动降 LOD。
"""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import struct
import sys

import numpy as np


MAGIC = b"BLMIP001"
# 独立padding多保留一个基础texel数值边界；runtime仍要求fragment highp >=23 bits。
UV_GUARD_TEXELS = 1
EDGE_DTYPE = np.dtype([("a", "<u8"), ("b", "<u8"), ("face", "<u4"),
                       ("au", "<f8", (2,)), ("bu", "<f8", (2,))])


def _integer(value, low: int, high: int, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) or not low <= value <= high:
        raise ValueError(f"光照 mip {name} 超出范围。")
    return int(value)


def _layout(width: int, height: int, levels: int) -> list[tuple[int, int]]:
    width, height = _integer(width, 2, 8192, "width"), _integer(height, 2, 8192, "height")
    _integer(levels, 1, 4, "additionalLevels")
    if width & (width - 1) or height & (height - 1) or levels > int(math.log2(max(width, height))):
        raise ValueError("光照 mip 尺寸必须为 2 的幂，层级不能超过完整链。")
    return [(max(1, width >> level), max(1, height >> level)) for level in range(levels + 1)]


def _positive_budget(value, name: str) -> int:
    return _integer(value, 1, 0xffffffff, name)


def _cross(a, b, point):
    return (b[0] - a[0]) * (point[..., 1] - a[1]) - (b[1] - a[1]) * (point[..., 0] - a[0])


def _triangles_overlap(a: np.ndarray, b: np.ndarray) -> bool:
    # 凸三角形 SAT；只接触边/点没有正面积交集。接近数值歧义的输入已在上游拒绝。
    for triangle in (a, b):
        for edge in range(3):
            delta = triangle[(edge + 1) % 3] - triangle[edge]
            axis = np.array([-delta[1], delta[0]])
            ap, bp = a @ axis, b @ axis
            if float(ap.max()) <= float(bp.min()) or float(bp.max()) <= float(ap.min()):
                return False
    return True


def _components(indices: np.ndarray, uv: np.ndarray) -> tuple[list[np.ndarray], list[tuple[np.ndarray, np.ndarray, int]]]:
    count = len(indices)
    parent = np.arange(count, dtype=np.int32)

    def find(value):
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return int(value)

    edges = np.empty(count * 3, dtype=EDGE_DTYPE)
    for corner in range(3):
        target = edges[corner * count:(corner + 1) * count]
        a, b = indices[:, corner], indices[:, (corner + 1) % 3]
        forward = a < b
        target["a"], target["b"] = np.minimum(a, b), np.maximum(a, b)
        target["face"] = np.arange(count, dtype=np.uint32)
        target["au"] = np.where(forward[:, None], uv[:, corner], uv[:, (corner + 1) % 3])
        target["bu"] = np.where(forward[:, None], uv[:, (corner + 1) % 3], uv[:, corner])
    edges.sort(order=["a", "b"], kind="quicksort")
    boundary = []
    start = 0
    while start < len(edges):
        end = start + 1
        while end < len(edges) and edges[end]["a"] == edges[start]["a"] and edges[end]["b"] == edges[start]["b"]:
            end += 1
        group = edges[start:end]
        if len(group) > 2:
            raise ValueError("光照 mip chart 存在非流形边，无法证明覆盖。")
        if len(group) == 2 and np.array_equal(group[0]["au"], group[1]["au"]) and np.array_equal(group[0]["bu"], group[1]["bu"]):
            first, second = find(int(group[0]["face"])), find(int(group[1]["face"]))
            parent[max(first, second)] = min(first, second)
        else:
            boundary.extend((entry["au"].copy(), entry["bu"].copy(), int(entry["face"])) for entry in group)
        start = end
    groups = {}
    for face in range(count):
        groups.setdefault(find(face), []).append(face)
    # 数值排序使 chart id、等距种子选择和输出跨运行稳定。
    return [np.asarray(faces, dtype=np.int32) for _, faces in sorted(groups.items())], boundary


def certify_lightmap_mip_charts(meshes: list[dict], width: int, height: int, additional_levels: int, *,
                               max_working_bytes: int, max_pixel_tests: int | None = None,
                               max_triangle_pairs: int = 2_000_000) -> tuple[dict, np.ndarray]:
    """返回包含真实 pixel-center 种子的 chart 证明；owner=-1 不代表黑色无效。

    meshes 每项为 key、triangles(F,3 原顶点id)、bakeUvs(F,3,2 最终float32UV)。
    UV seam 必须保持每角点数据；不同 mesh 永不合并成一个 chart。
    """
    _layout(width, height, additional_levels)
    maximum = _positive_budget(max_working_bytes, "maxWorkingBytes")
    if not meshes or not isinstance(meshes, list) or not all(isinstance(mesh, dict) for mesh in meshes):
        raise ValueError("光照 mip 缺少真实三角形 chart 输入。")
    face_count = sum(len(mesh.get("triangles", [])) for mesh in meshes)
    _integer(face_count, 1, 1_000_000, "triangleCount")
    # 包括原始/候选 RGBA、种子owner、精确EDT、边排序与逐行scratch的保守峰值界。
    # 不只统计ndarray.nbytes：每chart/face还有Python对象、边界/排序记录和gamma double临时值。
    # 这是准入用的保守上界估计，不宣称等于进程RSS；达不到预算就拒绝该recipe。
    estimated = width * height * 160 + face_count * 4096
    if estimated > maximum:
        raise ValueError(f"光照 mip 认证工作集预算不足：{estimated}>{maximum}。")
    pixel_budget = max_pixel_tests if max_pixel_tests is not None else width * height * 32
    _positive_budget(pixel_budget, "maxPixelTests")
    _positive_budget(max_triangle_pairs, "maxTrianglePairs")
    owner = np.full((height, width), -1, dtype=np.int32)
    charts, triangles_all, boundaries = [], [], []
    triangle_tests, pair_tests = 0, 0
    keys = set()
    for mesh in meshes:
        key = mesh.get("key")
        indices, original_uv = np.asarray(mesh.get("triangles")), np.asarray(mesh.get("bakeUvs"))
        if not isinstance(key, str) or not key or len(key) > 4096 or key in keys:
            raise ValueError("光照 mip mesh 身份缺失或重复。")
        keys.add(key)
        if indices.ndim != 2 or indices.shape[1] != 3 or indices.dtype.kind not in "iu" or indices.size == 0 or np.any(indices < 0):
            raise ValueError("光照 mip 三角拓扑无效。")
        if original_uv.dtype != np.float32 or original_uv.shape != (*indices.shape, 2) or not np.isfinite(original_uv).all():
            raise ValueError("光照 mip 需要最终逐角点 float32 UV，未知/非有限覆盖已拒绝。")
        if np.any(original_uv < 0) or np.any(original_uv > 1) or np.any(np.sort(indices, axis=1)[:, 1:] == np.sort(indices, axis=1)[:, :-1]):
            raise ValueError("光照 mip UV 越界或三角形退化。")
        uv = original_uv.astype(np.float64)
        uv *= np.array([width, height])
        # 三角形批量面积明确指定角点轴，避免把 face 维误作坐标轴。
        area = (uv[:, 1, 0] - uv[:, 0, 0]) * (uv[:, 2, 1] - uv[:, 0, 1]) - (uv[:, 1, 1] - uv[:, 0, 1]) * (uv[:, 2, 0] - uv[:, 0, 0])
        if np.any(np.abs(area) < 1e-8):
            raise ValueError("光照 mip chart 存在退化/数值歧义三角形。")
        components, outer_edges = _components(indices, uv)
        face_chart = np.empty(len(indices), dtype=np.int32)
        for faces in components:
            chart_id = len(charts)
            face_chart[faces] = chart_id
            triangle = uv[faces]
            low, high = triangle.min(axis=(0, 1)), triangle.max(axis=(0, 1))
            footprints = []
            for level in range(additional_levels + 1):
                step = 1 << level
                lower = np.floor((low - UV_GUARD_TEXELS) / step - .5).astype(np.int64) * step
                upper = (np.floor((high + UV_GUARD_TEXELS) / step - .5).astype(np.int64) + 2) * step
                if np.any(lower < 0) or upper[0] > width or upper[1] > height:
                    raise ValueError(f"光照 mip chart {key}/{chart_id} 足印越过 atlas 边界。")
                footprints.append([int(lower[0]), int(lower[1]), int(upper[0]), int(upper[1])])
            rectangle = [min(box[0] for box in footprints), min(box[1] for box in footprints),
                         max(box[2] for box in footprints), max(box[3] for box in footprints)]
            charts.append({"id": chart_id, "meshKey": key, "triangleCount": len(faces), "bounds": [*low.tolist(), *high.tolist()],
                           "footprints": footprints, "rectangle": rectangle, "seedCount": 0})
        boundaries.extend((a, b, int(face_chart[face])) for a, b, face in outer_edges)
        triangles_all.extend((triangle, int(face_chart[index])) for index, triangle in enumerate(uv))
    # 不同 chart 的 box-filter+bilinear 全足印不允许相交；相切可接受（半开texel区间）。
    active = []
    for chart in sorted(charts, key=lambda value: (value["rectangle"][0], value["id"])):
        x0, y0, x1, y1 = chart["rectangle"]
        active = [other for other in active if other["rectangle"][2] > x0]
        for other in active:
            pair_tests += 1
            if pair_tests > max_triangle_pairs:
                raise ValueError("光照 mip chart 交叠检查超过工作预算。")
            if other["rectangle"][1] < y1 and other["rectangle"][3] > y0:
                raise ValueError("光照 mip 不同 UV chart 的实际采样足印重叠，未自动repack或降LOD。")
        active.append(chart)
    # chart 内也不能把折叠/重叠UV伪装成已证明的连续区域。
    active_triangles = []
    ordered = sorted(triangles_all, key=lambda item: float(item[0][:, 0].min()))
    for triangle, chart_id in ordered:
        low, high = triangle.min(0), triangle.max(0)
        active_triangles = [(other, other_id, bound) for other, other_id, bound in active_triangles if bound[2] > low[0]]
        for other, other_id, bound in active_triangles:
            pair_tests += 1
            if pair_tests > max_triangle_pairs:
                raise ValueError("光照 mip 三角覆盖检查超过工作预算。")
            if chart_id != other_id or bound[1] >= high[1] or bound[3] <= low[1]:
                continue
            if _triangles_overlap(triangle, other):
                raise ValueError("光照 mip chart 自重叠，无法证明 bake 种子来源。")
        active_triangles.append((triangle, chart_id, (*low, *high)))
        x0, y0 = np.maximum(np.ceil(low - .5).astype(int), 0)
        x1, y1 = np.minimum(np.floor(high - .5).astype(int) + 1, [width, height])
        triangle_tests += int(max(0, x1 - x0) * max(0, y1 - y0))
        if triangle_tests > pixel_budget:
            raise ValueError("光照 mip 三角 raster 超过工作预算。")
        for y in range(y0, y1):
            points = np.column_stack((np.arange(x0, x1, dtype=np.float64) + .5, np.full(x1 - x0, y + .5)))
            signs = [_cross(triangle[edge], triangle[(edge + 1) % 3], points) for edge in range(3)]
            # 包含内部共享边；稍后逐外边检查，所有外边上的pixel-center都属于未知覆盖。
            inside = np.logical_or(np.logical_and.reduce([sign >= 0 for sign in signs]), np.logical_and.reduce([sign <= 0 for sign in signs]))
            current = owner[y, x0:x1]
            if np.any(inside & (current >= 0) & (current != chart_id)):
                raise ValueError("光照 mip 种子被多个 chart 占用。")
            current[inside] = chart_id
    for a, b, chart_id in boundaries:
        low, high = np.minimum(a, b), np.maximum(a, b)
        x0, y0 = np.maximum(np.ceil(low - .5).astype(int), 0)
        x1, y1 = np.minimum(np.floor(high - .5).astype(int) + 1, [width, height])
        triangle_tests += int(max(0, x1 - x0) * max(0, y1 - y0))
        if triangle_tests > pixel_budget:
            raise ValueError("光照 mip 外边覆盖检查超过工作预算。")
        for y in range(y0, y1):
            points = np.column_stack((np.arange(x0, x1, dtype=np.float64) + .5, np.full(x1 - x0, y + .5)))
            if np.any((np.abs(_cross(a, b, points)) < 1e-8) & (owner[y, x0:x1] == chart_id)):
                raise ValueError("光照 mip pixel-center 位于 chart 外边，无法证明实际 bake 覆盖。")
    for chart in charts:
        x0, y0, x1, y1 = chart["rectangle"]
        chart["seedCount"] = int(np.count_nonzero(owner[y0:y1, x0:x1] == chart["id"]))
        if chart["seedCount"] == 0:
            raise ValueError("光照 mip chart 没有已证明的内部 pixel-center 种子。")
    return {"version": 1, "width": width, "height": height, "additionalLevels": additional_levels,
            "uvGuardTexels": UV_GUARD_TEXELS, "requiredFragmentPrecisionBits": 23,
            "estimatedWorkingBytes": estimated, "pixelTests": triangle_tests, "pairTests": pair_tests,
            "padding": "nearest-same-chart-euclidean-tie-bottom-first", "charts": charts}, owner


def _nearest_seed_ids(mask: np.ndarray) -> np.ndarray:
    """精确平方欧氏 EDT；等距选最小 bottom-first 种子id，不依赖颜色。"""
    height, width = mask.shape
    x = np.arange(width, dtype=np.int32)[None, :]
    left = np.maximum.accumulate(np.where(mask, x, -width), axis=1)
    right = np.minimum.accumulate(np.where(mask, x, 2 * width)[:, ::-1], axis=1)[:, ::-1]
    choose_left = x - left <= right - x
    nearest_x = np.where(choose_left, left, right).astype(np.int32)
    nearest_x[(nearest_x < 0) | (nearest_x >= width)] = -1
    result = np.empty((height, width), dtype=np.int32)
    candidates, starts = np.empty(height, dtype=np.int32), np.empty(height, dtype=np.int64)
    for col in range(width):
        rows = np.flatnonzero(nearest_x[:, col] >= 0)
        if not len(rows):
            raise ValueError("光照 mip EDT 未找到种子。")
        distances = (nearest_x[:, col].astype(np.int64) - col) ** 2
        count = 0
        for row in rows:
            start = -0x7fffffff
            while count:
                previous = int(candidates[count - 1])
                # 新行严格更近才换种子；整数交点避免 float 舍入破坏等距次序。
                start = (int(distances[row] + row * row) - int(distances[previous] + previous * previous)) // (2 * (int(row) - previous)) + 1
                if start > starts[count - 1]:
                    break
                count -= 1
            candidates[count], starts[count] = row, start if count else -0x7fffffff
            count += 1
        current = 0
        for row in range(height):
            while current + 1 < count and starts[current + 1] <= row:
                current += 1
            seed_row = int(candidates[current])
            result[row, col] = seed_row * width + nearest_x[seed_row, col]
    return result


def pad_linear_lightmap(pixels: np.ndarray, certificate: dict, owner: np.ndarray) -> np.ndarray:
    width, height = certificate["width"], certificate["height"]
    source = np.asarray(pixels)
    if source.dtype != np.float32 or source.size != width * height * 4 or not np.isfinite(source).all() or np.any(source.reshape(-1, 4)[:, :3] < 0):
        raise ValueError("光照 mip 需要成功 bake 的有限非负 float32 RGBA，未猜测黑色像素资格。")
    if owner.shape != (height, width) or owner.dtype != np.int32:
        raise ValueError("光照 mip 种子证明尺寸不一致。")
    rgba = source.reshape(height, width, 4)
    padded = rgba.copy()
    for chart in certificate["charts"]:
        x0, y0, x1, y1 = chart["rectangle"]
        mask = owner[y0:y1, x0:x1] == chart["id"]
        if not np.any(mask) or int(mask.sum()) != chart["seedCount"]:
            raise ValueError("光照 mip 种子证明已失效。")
        nearest = _nearest_seed_ids(mask)
        rect_width = x1 - x0
        # 逐行 gather 限定临时数组，不物化整张 atlas 的 double RGB 副本。
        for row in range(y1 - y0):
            ids = nearest[row]
            padded[y0 + row, x0:x1, :3] = rgba[y0 + ids // rect_width, x0 + ids % rect_width, :3]
    padded[:, :, 3] = 1
    return padded.reshape(-1)


def linear_mip_levels(pixels: np.ndarray, width: int, height: int, additional_levels: int) -> list[np.ndarray]:
    layout = _layout(width, height, additional_levels)
    source = np.asarray(pixels)
    if source.dtype != np.float32 or source.size != width * height * 4 or not np.isfinite(source).all():
        raise ValueError("光照 mip 线性过滤输入无效。")
    levels = [source.reshape(height, width, 4)]
    for out_width, out_height in layout[1:]:
        previous = levels[-1]
        # 固定求和顺序，源为线性 irradiance；绝不平均 RGBM 或其乘数通道。
        x0, y0 = np.arange(out_width) * 2, np.arange(out_height) * 2
        x1, y1 = np.minimum(x0 + 1, previous.shape[1] - 1), np.minimum(y0 + 1, previous.shape[0] - 1)
        rgb = np.add(previous[y0[:, None], x0, :3], previous[y0[:, None], x1, :3], dtype=np.float64)
        np.add(rgb, previous[y1[:, None], x0, :3], out=rgb)
        np.add(rgb, previous[y1[:, None], x1, :3], out=rgb)
        rgb *= .25
        level = np.ones((out_height, out_width, 4), dtype=np.float32)
        level[:, :, :3] = rgb
        levels.append(level)
    return levels


def quantize_blender_rgba8(encoded: np.ndarray) -> np.ndarray:
    """Blender5.2.2 Non-Color/CHANNEL_PACKED PNG 微oracle锁定的float32量化。"""
    source = np.asarray(encoded)
    if source.dtype != np.float32 or not np.isfinite(source).all() or np.any(source < 0) or np.any(source > 1):
        raise ValueError("光照 mip 量化需要有限 [0,1] float32 编码。")
    scaled = np.multiply(source, np.float32(255))
    np.add(scaled, np.float32(.5), out=scaled)
    np.floor(scaled, out=scaled)
    return scaled.astype(np.uint8)


def _encode_linear(pixels: np.ndarray, dynamic_range: float) -> np.ndarray:
    rgba = pixels.reshape(-1, 4)
    rgb = rgba[:, :3]
    multiplier = rgb.max(axis=1).astype(np.float64)
    multiplier /= dynamic_range
    multiplier *= 255
    np.ceil(multiplier, out=multiplier)
    multiplier /= 255
    np.maximum(multiplier, 1 / 255, out=multiplier)
    encoded = np.empty_like(rgba)
    np.divide(rgb, multiplier[:, None] * dynamic_range, out=encoded[:, :3])
    encoded[:, 3] = multiplier
    return encoded


def encode_lightmap_mip_container(levels: list[np.ndarray], rgbm_range: float, base_encoding: str, max_texture_bytes: int) -> bytes:
    if base_encoding not in ("rgbm", "rgbm-gamma") or not math.isfinite(rgbm_range) or rgbm_range < 1:
        raise ValueError("光照 mip 容器编码/范围无效。")
    if not 2 <= len(levels) <= 5 or levels[0].ndim != 3 or levels[0].shape[2] != 4:
        raise ValueError("光照 mip 容器缺少完整层级。")
    height, width = levels[0].shape[:2]
    layout = _layout(width, height, len(levels) - 1)
    total = sum(w * h * 4 for w, h in layout)
    if total > _positive_budget(max_texture_bytes, "maxTextureBytes"):
        raise ValueError("光照 mip 全链 RGBA 超过预算。")
    header_bytes = 64 + 16 * len(levels)
    output = bytearray(header_bytes + total)
    struct.pack_into("<8sHBBIIIII dII", output, 0, MAGIC, 1, 1, int(base_encoding == "rgbm-gamma"),
                     header_bytes, width, height, len(levels), 1, rgbm_range, total, len(output))
    offset = header_bytes
    for index, (level, (w, h)) in enumerate(zip(levels, layout)):
        if level.dtype != np.uint8 or level.shape != (h, w, 4):
            raise ValueError("光照 mip 容器层级数据不一致。")
        length = w * h * 4
        struct.pack_into("<IIII", output, 64 + 16 * index, w, h, offset, length)
        output[offset:offset + length] = level.tobytes(order="C")
        offset += length
    return bytes(output)


def prepare_lightmap_mips(pixels: np.ndarray, width: int, height: int, meshes: list[dict], additional_levels: int,
                         base_encoding: str, *, max_working_bytes: int, max_texture_bytes: int) -> dict:
    """主py接线入口：完全认证后才返回新候选 bytes；异常时上层保留原结果。"""
    if base_encoding not in ("rgbm", "rgbm-gamma"):
        raise ValueError("光照 mip 未知 texel 编码。")
    layout = _layout(width, height, additional_levels)
    texture_bytes = sum(w * h * 4 for w, h in layout)
    if texture_bytes > _positive_budget(max_texture_bytes, "maxTextureBytes"):
        raise ValueError("光照 mip 全链 RGBA 超过预算。")
    certificate, owner = certify_lightmap_mip_charts(meshes, width, height, additional_levels, max_working_bytes=max_working_bytes)
    padded = pad_linear_lightmap(pixels, certificate, owner)
    levels = linear_mip_levels(padded, width, height, additional_levels)
    # 全atlas原线性范围保持不变，padding只复制既有值，filter也不增加最大值。
    dynamic_range = max(1, math.ceil(float(np.max(np.asarray(pixels).reshape(-1, 4)[:, :3], initial=1))))
    gamma = None
    if base_encoding == "rgbm-gamma":
        spec = importlib.util.spec_from_file_location("lighting_mips_gamma", Path(__file__).with_name("rgbm_gamma_codec.py"))
        gamma = importlib.util.module_from_spec(spec)
        # Blender忽略PYTHONDONTWRITEBYTECODE环境变量；只在本次受控导入内禁写，异常也恢复宿主状态。
        previous_bytecode = sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            spec.loader.exec_module(gamma)
        finally:
            sys.dont_write_bytecode = previous_bytecode
    encoded = []
    for level in levels:
        floats = gamma.encode_rgbm_gamma_pixels(level.reshape(-1), fixed_range=dynamic_range)[1] if gamma else _encode_linear(level, dynamic_range)
        encoded.append(quantize_blender_rgba8(floats.reshape(level.shape)))
    return {"data": encode_lightmap_mip_container(encoded, dynamic_range, base_encoding, max_texture_bytes),
            "encoding": "rgbm-gamma-mips-v1" if gamma else "rgbm-linear-mips-v1", "rgbmRange": dynamic_range,
            "width": width, "height": height, "levelCount": len(layout), "textureBytes": texture_bytes,
            "certificate": certificate}
