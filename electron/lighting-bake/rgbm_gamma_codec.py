"""可选 Gamma RGBM 编码；不调用 Blender，不修改调用方输入或旧线性编码器。"""
from __future__ import annotations

import math

import numpy as np


def encode_rgbm_gamma_pixels(pixels: np.ndarray, fixed_range: float | None = None) -> tuple[float, np.ndarray]:
    """在线性 irradiance 上开方，R 保持在线性域；解码必须为 (RGB*M)^2*R。"""
    source = np.asarray(pixels)
    if source.dtype.kind != "f" or source.size == 0 or source.size % 4:
        raise ValueError("Gamma RGBM 输入必须是非空浮点 RGBA 数组。")
    if not np.isfinite(source).all():
        raise ValueError("Gamma RGBM 输入包含非有限值。")
    rgba = source.reshape(-1, 4)
    # 上游 bake 已消除负辐照度；独立调用也保守裁剪，不能修改共享像素缓冲。
    rgb = np.maximum(rgba[:, :3], 0)
    maximum = float(np.max(rgb, initial=1))
    if fixed_range is None:
        dynamic_range = max(1, math.ceil(maximum))
    else:
        if isinstance(fixed_range, (bool, np.bool_)) or not isinstance(fixed_range, (int, float, np.number)):
            raise ValueError("Gamma RGBM 固定范围必须是有限数字。")
        dynamic_range = float(fixed_range)
        if not math.isfinite(dynamic_range) or dynamic_range < 1 or dynamic_range < maximum:
            raise ValueError("Gamma RGBM 固定范围不足或无效，未裁剪高亮。")
    # double 中间值避免 sqrt/ceil 边界受 float32 运算次序影响。
    normalized = np.sqrt(rgb.astype(np.float64) / dynamic_range)
    multiplier = normalized.max(axis=1)
    multiplier *= 255
    np.ceil(multiplier, out=multiplier)
    multiplier /= 255
    np.maximum(multiplier, 1 / 255, out=multiplier)
    encoded = np.empty_like(rgba)
    np.divide(normalized, multiplier[:, None], out=encoded[:, :3])
    encoded[:, 3] = multiplier
    return dynamic_range, encoded.reshape(-1)
