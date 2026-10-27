"""任务级 packed UV/布局缓存；只读主进程已验证并复制到本任务的固定文件。"""
from __future__ import annotations

from array import array
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time

import bpy
import numpy as np

FORMAT = "lighting-bake-packed-uv-v1"
FIELDS = ("positions", "normals", "indices", "uvs", "uvs2", "colors", "tangents")
WIDTHS = {"positions": 3, "normals": 3, "indices": 1, "uvs": 2, "uvs2": 2, "colors": 4, "tangents": 4}
DTYPES = {"float64": "<f8", "uint32": "<u4", "float32": "<f4"}
MANIFEST = "preprocess-cache.json"
PAYLOAD = "preprocess-cache.bin"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def integer(value, minimum=0) -> bool:
    return type(value) is int and minimum <= value <= 2 ** 53 - 1


def digest_string(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def hash_value(digest, value) -> None:
    """与 TS 共用有类型的流式身份编码；浮点数不依赖 JSON 的指数表示。"""
    if value is None:
        digest.update(b"n")
    elif type(value) is bool:
        digest.update(b"t" if value else b"f")
    elif type(value) in (int, float):
        require(math.isfinite(value), "UV 缓存身份含非有限数值")
        digest.update(b"d" + struct.pack("<d", value))
    elif isinstance(value, str):
        encoded = value.encode("utf-8")
        digest.update(b"s" + struct.pack("<I", len(encoded)) + encoded)
    elif isinstance(value, (list, tuple)):
        digest.update(b"a" + struct.pack("<I", len(value)))
        for item in value:
            hash_value(digest, item)
    elif isinstance(value, dict):
        digest.update(b"o" + struct.pack("<I", len(value)))
        for name in sorted(value):
            hash_value(digest, name)
            hash_value(digest, value[name])
    else:
        raise ValueError("UV 缓存身份字段无效")


def identity_hash(value) -> str:
    digest = hashlib.sha256()
    hash_value(digest, value)
    return digest.hexdigest()


def numeric_digest(values, field) -> str:
    values = np.asarray(values, dtype="<u4" if field == "indices" else "<f8")
    return hashlib.sha256(memoryview(values).cast("B")).hexdigest()


def input_key(inputs: list[dict], settings: dict, mip_recipe: str) -> str:
    levels = settings.get("lightmapMipLevels", 0)
    digest = hashlib.sha256()
    hash_value(digest, {"format": FORMAT, "recipe": "world-partition64-24-smart66-margin002-repair-jacobian-shelf-v1",
        "materialSlots": "source-order-single-slot0", "inputVersion": 1, "count": len(inputs),
        "atlasSize": settings["atlasSize"], "density": settings["texelsPerMeter"], "textureBudgetMiB": settings["maxTextureMiB"],
        "mipLevels": levels, "mipRecipe": mip_recipe, "encoding": settings.get("lightmapEncoding", "rgbm"),
        "gutter": 4 if levels == 0 else math.ceil(1.5 * (1 << levels)) + 2})
    for source in inputs:
        material = source["material"]
        textures = material.get("textures", {})
        hash_value(digest, {"key": source["key"], "entityId": source["entityId"], "nodeKey": source["nodeKey"], "name": source["name"],
            "worldMatrix": source["worldMatrix"], "receiver": source.get("receiver", True),
            "materialUv": {"fields": sorted(material), "textures": [[kind, textures[kind].get("coordinatesIndex")
                if isinstance(textures[kind], dict) else None] for kind in sorted(textures)]},
            "attributes": {field: {"type": "uint32" if field == "indices" else "float64", "length": len(source[field]),
                "sha256": numeric_digest(source[field], field)} for field in FIELDS if field in source}})
    return digest.hexdigest()


def read_regular(root: Path, name: str, maximum: int) -> bytes:
    file = root / name
    before = file.lstat()
    require(stat.S_ISREG(before.st_mode) and not file.is_symlink() and file.resolve().parent == root.resolve()
        and before.st_size <= maximum, "UV 缓存文件归属或大小无效")
    with file.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size), "UV 缓存文件被替换")
        data = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    current = file.lstat()
    require(len(data) == before.st_size and (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
        and stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (before.st_dev, before.st_ino), "UV 缓存文件读取期间变化")
    return data


def tile_path(original: str, key: str) -> str:
    if key == original:
        return ""
    match = re.search(r"/tile:([01]+)$", original)
    prefix = original if match else original + "/tile:"
    require(key.startswith(prefix), "UV 缓存切片来源不匹配")
    suffix = key[len(prefix):]
    require(bool(suffix) and set(suffix) <= {"0", "1"} and len(suffix) + (len(match[1]) if match else 0) <= 64, "UV 缓存切片路径无效")
    return suffix


def validate_coverage(rows: list[dict], inputs: list[dict]) -> None:
    groups = [[] for _ in inputs]
    for row in rows:
        groups[row["sourceIndex"]].append(tile_path(inputs[row["sourceIndex"]]["key"], row["key"]))
    for paths in groups:
        require(bool(paths) and paths == sorted(paths) and len(set(paths)) == len(paths), "UV 缓存来源顺序或覆盖不完整")
        leaves = set(paths)
        for leaf in sorted(paths, key=len, reverse=True):
            while leaf and leaf in leaves:
                sibling = leaf[:-1] + ("1" if leaf[-1] == "0" else "0")
                if sibling not in leaves:
                    break
                leaves.remove(leaf)
                leaves.remove(sibling)
                leaf = leaf[:-1]
                require(leaf not in leaves, "UV 缓存切片重叠")
                leaves.add(leaf)
        require(leaves == {""}, "UV 缓存切片不是完整二叉叶集")


class PreprocessCache:
    def __init__(self, root: Path, control: dict, inputs: list[dict], settings: dict, mip_recipe: str, file_digest, progress) -> None:
        self.root, self.control, self.inputs, self.settings, self.progress = root, control, inputs, settings, progress
        self.diagnostic = {"status": "miss", "reason": str(control.get("reason", "无可用 UV 缓存"))[:1024],
                           "lookupDurationMs": control.get("lookupDurationMs", 0)}
        require(control.get("version") == 1 and all(integer(control.get(field), 1) for field in
            ("maxPayloadBytes", "maxManifestBytes", "maxObjects", "maxWorkingBytes", "maxWriteBytes", "chunkBytes")), "UV 缓存预算无效")
        require(control["maxWorkingBytes"] <= 1024 ** 3 and control["maxManifestBytes"] <= 4 * 1024 ** 2
            and (control["maxPayloadBytes"] + control["maxManifestBytes"]) * 8 <= control["maxWorkingBytes"]
            and control["maxObjects"] <= control["maxManifestBytes"] // 512
            and control["chunkBytes"] <= 4 * 1024 ** 2, "UV 缓存额外内存预算无效")
        started = time.monotonic()
        actual_input = input_key(inputs, settings, mip_recipe)
        scripts = ["cycles_bake.py", "preprocess_cache.py"] + (["lightmap_mips.py"] if settings.get("lightmapMipLevels", 0) else [])
        actual_algorithm = identity_hash([[name, file_digest(root / name)] for name in scripts])
        require(actual_input == control.get("inputKey") and actual_algorithm == control.get("algorithmKey"), "本次 UV 输入或算法与主进程校验不一致")
        self.blender_version = bpy.app.version_string
        self.blender_build = bpy.app.build_hash.decode("ascii", errors="replace")
        self.key = identity_hash([FORMAT, actual_input, actual_algorithm, self.blender_version, self.blender_build])
        self.diagnostic["key"] = self.key
        self.diagnostic["restoreDurationMs"] = round((time.monotonic() - started) * 1000)

    def emit(self) -> None:
        self.diagnostic["reason"] = self.diagnostic["reason"][:1024]
        print("LIGHTING_BAKE_PREPROCESS " + json.dumps(self.diagnostic, ensure_ascii=False, allow_nan=False), flush=True)

    def manifest(self, encoded: bytes) -> dict:
        record = json.loads(encoded)
        require(isinstance(record, dict) and set(record) == {"format", "stage", "inputKey", "algorithmKey", "key", "blenderVersion", "blenderBuild",
            "inputCount", "objects", "pages", "payload"} and record["format"] == FORMAT and record["stage"] == "packed"
            and record["inputKey"] == self.control["inputKey"] and record["algorithmKey"] == self.control["algorithmKey"]
            and record["key"] == self.key and record["blenderVersion"] == self.blender_version and record["blenderBuild"] == self.blender_build,
            "UV 缓存 Blender/算法/输入版本不匹配")
        rows, payload, pages = record["objects"], record["payload"], record["pages"]
        require(type(record["inputCount"]) is int and record["inputCount"] == len(self.inputs)
            and isinstance(rows, list) and len(self.inputs) <= len(rows) <= self.control["maxObjects"]
            and isinstance(pages, list) and len(pages) <= len(rows)
            and isinstance(payload, dict) and set(payload) == {"byteLength", "sha256"}
            and integer(payload["byteLength"], 8) and payload["byteLength"] <= self.control["maxPayloadBytes"]
            and digest_string(payload["sha256"])
            and (payload["byteLength"] + len(encoded)) * 8 <= self.control["maxWorkingBytes"], "UV 缓存整包大小/数量无效")
        offset, previous_source, seen = 8, 0, set()

        def attribute(entry, kind, count):
            nonlocal offset
            width = 8 if kind == "float64" else 4
            offset = (offset + width - 1) // width * width
            require(isinstance(entry, dict) and set(entry) == {"byteOffset", "length", "type"} and entry["type"] == kind
                and integer(entry["byteOffset"], 8) and entry["byteOffset"] == offset and integer(entry["length"])
                and entry["length"] == count and offset + count * width <= payload["byteLength"], "UV 缓存属性偏移或数量无效")
            offset += count * width

        for row in rows:
            require(isinstance(row, dict) and set(row) == {"sourceIndex", "key", "vertexCount", "triangleCount", "atlas", "repairCount",
                "attributes", "loopVertices", "winding", "lightmapUvs"}
                and integer(row["sourceIndex"]) and previous_source <= row["sourceIndex"] < len(self.inputs)
                and isinstance(row["key"], str) and row["key"] not in seen
                and integer(row["vertexCount"], 1) and integer(row["triangleCount"], 1)
                and integer(row["repairCount"]) and row["repairCount"] <= row["triangleCount"], "UV 缓存对象身份无效")
            previous_source = row["sourceIndex"]
            seen.add(row["key"])
            source = self.inputs[row["sourceIndex"]]
            require(isinstance(row["attributes"], dict) and set(row["attributes"]) == {field for field in FIELDS if field in source}, "UV 缓存属性映射无效")
            for field in FIELDS:
                if field in row["attributes"]:
                    attribute(row["attributes"][field], "uint32" if field == "indices" else "float64",
                        row["triangleCount"] * 3 if field == "indices" else row["vertexCount"] * WIDTHS[field])
            attribute(row["loopVertices"], "uint32", row["triangleCount"] * 3)
            attribute(row["winding"], "uint32", row["triangleCount"])
            attribute(row["lightmapUvs"], "float32", row["triangleCount"] * 6)
            require((row["atlas"] is None and row["key"] == source["key"]) if source.get("receiver", True) is False
                else integer(row["atlas"]) and row["atlas"] < len(pages), "UV 缓存 receiver 映射无效")
        require(offset == payload["byteLength"], "UV 缓存载荷含未声明字节")
        validate_coverage(rows, self.inputs)
        members = set()
        for atlas, page in enumerate(pages):
            require(isinstance(page, list) and bool(page), "UV 缓存空图集无效")
            for index in page:
                require(integer(index) and index < len(rows) and index not in members and rows[index]["atlas"] == atlas, "UV 缓存图集成员无效")
                members.add(index)
        require(all((row["atlas"] is not None) == (index in members) for index, row in enumerate(rows)), "UV 缓存图集覆盖不完整")
        return record

    def restore(self, make_mesh, validate_layout, world_per_uv):
        candidate = self.control.get("candidate")
        if not candidate:
            self.progress("preprocess", 0, 1, "UV/布局缓存未命中：" + self.diagnostic["reason"])
            self.emit()
            return None
        started = time.monotonic()
        before_objects, before_meshes = set(bpy.data.objects), set(bpy.data.meshes)
        try:
            require(isinstance(candidate, dict) and set(candidate) == {"manifestSha256", "payloadSha256", "key"}
                and all(digest_string(value) for value in candidate.values()), "UV 缓存暂存凭据无效")
            encoded = read_regular(self.root, MANIFEST, self.control["maxManifestBytes"])
            require(hashlib.sha256(encoded).hexdigest() == candidate["manifestSha256"], "UV 缓存清单 SHA 不匹配")
            record = self.manifest(encoded)
            require(candidate["key"] == self.key and candidate["payloadSha256"] == record["payload"]["sha256"], "UV 缓存暂存身份不匹配")
            raw = read_regular(self.root, PAYLOAD, record["payload"]["byteLength"])
            require(len(raw) == record["payload"]["byteLength"] and raw[:8] == b"BLUV0001"
                and hashlib.sha256(raw).hexdigest() == record["payload"]["sha256"], "UV 缓存载荷长度/头/SHA 不匹配")

            def read_array(entry):
                values = np.frombuffer(raw, dtype=DTYPES[entry["type"]], count=entry["length"], offset=entry["byteOffset"])
                require(bool(np.all(np.isfinite(values))), "UV 缓存含非有限数值")
                result = array({"float64": "d", "uint32": "I", "float32": "f"}[entry["type"]])
                result.frombytes(memoryview(values).cast("B"))
                if sys.byteorder != "little":
                    result.byteswap()
                return result

            sources, objects = [], []
            for index, row in enumerate(record["objects"]):
                original = self.inputs[row["sourceIndex"]]
                source = {**original, "key": row["key"]}
                for field, entry in row["attributes"].items():
                    source[field] = read_array(entry)
                    if row["key"] == original["key"]:
                        require(len(source[field]) == len(original[field]) and numeric_digest(source[field], field) == numeric_digest(original[field], field), "UV 缓存未切片几何与本次输入不一致")
                require(max(source["indices"], default=0) < row["vertexCount"], "UV 缓存索引越界")
                packed = {"loopVertices": read_array(row["loopVertices"]), "winding": read_array(row["winding"]),
                          "lightmapUvs": read_array(row["lightmapUvs"]), "atlas": row["atlas"], "repairCount": row["repairCount"]}
                for face, winding in enumerate(packed["winding"]):
                    require(winding in (0, 1), "UV 缓存绕序标记无效")
                    first, second, third = source["indices"][face * 3:face * 3 + 3]
                    expected = (first, third, second) if winding else (first, second, third)
                    require(tuple(packed["loopVertices"][face * 3:face * 3 + 3]) == expected, "UV 缓存 loop/原拓扑不匹配")
                # 材质在整包成功后由当前输入绑定；材质/纹理的真实失败不进入 cache-miss 捕获域。
                obj = make_mesh(source, self.root, index, packed=packed, build_material=False)
                require(len(obj.data.vertices) == row["vertexCount"] and len(obj.data.polygons) == row["triangleCount"]
                    and len(obj.data.loops) == len(packed["loopVertices"])
                    and all(loop.vertex_index == packed["loopVertices"][loop.index] for loop in obj.data.loops), "UV 缓存重建拓扑不一致")
                if row["atlas"] is not None:
                    require(all(0 <= value <= 1 for value in packed["lightmapUvs"]), "UV 缓存超出图集范围")
                    required = max((world_per_uv(obj, face) for face in obj.data.polygons), default=0) * self.settings["texelsPerMeter"]
                    require(math.isfinite(required) and required <= self.settings["atlasSize"] * (1 + 1e-6), "UV 缓存实际采样密度不足")
                sources.append(source)
                objects.append(obj)
            del raw
            pages = [[objects[index] for index in page] for page in record["pages"]]
            # 原有纹理/mip/chart 预算在成功交还前重跑；失败整包回退，原路径再次报告真实输入问题。
            validation = validate_layout(pages, sources, self.settings)
            self.diagnostic.update(status="hit", reason="已恢复并复验完整 packed UV/布局；材质按本次输入重建", bytes=len(encoded) + record["payload"]["byteLength"])
            self.diagnostic["restoreDurationMs"] += round((time.monotonic() - started) * 1000)
            self.progress("preprocess", 1, 1, f"UV/布局缓存命中，恢复与校验 {self.diagnostic['restoreDurationMs']} ms；光照仍按完整 GI 指纹")
            self.emit()
            self.inputs = []  # 求解阶段不再持有原始整包几何，避免与恢复后的切片重复驻留。
            return sources, objects, pages, validation
        except Exception as error:
            # 只回收本次尝试创建的数据块，不清空其它对象，也不触碰历史任务。
            for obj in set(bpy.data.objects) - before_objects:
                bpy.data.objects.remove(obj, do_unlink=True)
            for mesh in set(bpy.data.meshes) - before_meshes:
                bpy.data.meshes.remove(mesh)
            self.diagnostic["restoreDurationMs"] += round((time.monotonic() - started) * 1000)
            self.diagnostic.update(status="miss", reason=("UV/布局缓存恢复被拒绝：" + str(error))[:1024])
            self.progress("preprocess", 0, 1, self.diagnostic["reason"] + "；回到原始预处理")
            self.emit()
            return None

    def save(self, sources: list[dict], objects: list, pages: list[list], prepare_duration_ms: int) -> None:
        self.diagnostic["prepareDurationMs"] = prepare_duration_ms
        started, owned = time.monotonic(), set()
        try:
            require(len(objects) == len(sources) and len(objects) <= self.control["maxObjects"], "UV 缓存对象数量超过预算")
            input_indices = {source["key"]: index for index, source in enumerate(self.inputs)}
            offset = 8

            def descriptor(count, kind):
                nonlocal offset
                width = 8 if kind == "float64" else 4
                offset = (offset + width - 1) // width * width
                entry = {"byteOffset": offset, "length": count, "type": kind}
                offset += count * width
                return entry

            rows = []
            for source, obj in zip(sources, objects):
                key = source["key"]
                origin = key
                if origin not in input_indices:
                    match = re.search(r"/tile:([01]+)$", key)
                    require(match is not None, "UV 缓存缺少原始来源")
                    base, leaf = key[:match.start()], match[1]
                    while leaf and base + "/tile:" + leaf not in input_indices:
                        leaf = leaf[:-1]
                    origin = base + "/tile:" + leaf if leaf else base
                require(origin in input_indices, "UV 缓存来源映射缺失")
                mesh = obj.data
                require(all(len(face.loop_indices) == 3 and face.material_index == 0 for face in mesh.polygons)
                    and len(mesh.materials) == 1, "UV 缓存只接受当前单源单材质三角拓扑")
                rows.append({"sourceIndex": input_indices[origin], "key": key, "vertexCount": len(mesh.vertices), "triangleCount": len(mesh.polygons),
                    "atlas": int(obj["atlas"]) if source.get("receiver", True) else None, "repairCount": int(obj.get("lighting_uv_repair_count", 0)),
                    "attributes": {field: descriptor(len(source[field]), "uint32" if field == "indices" else "float64") for field in FIELDS if field in source},
                    "loopVertices": descriptor(len(mesh.loops), "uint32"), "winding": descriptor(len(mesh.polygons), "uint32"),
                    "lightmapUvs": descriptor(len(mesh.loops) * 2, "float32")})
            require(offset <= self.control["maxPayloadBytes"], "UV 缓存载荷超过单包预算")
            record = {"format": FORMAT, "stage": "packed", "inputKey": self.control["inputKey"], "algorithmKey": self.control["algorithmKey"],
                "key": self.key, "blenderVersion": self.blender_version, "blenderBuild": self.blender_build, "inputCount": len(self.inputs),
                "objects": rows, "pages": [[int(obj["input_index"]) for obj in page] for page in pages], "payload": {"byteLength": offset, "sha256": "0" * 64}}
            encoded = json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            require(len(encoded) <= self.control["maxManifestBytes"] and offset + len(encoded) <= self.control["maxWriteBytes"], "UV 缓存清单或磁盘预算不足")
            self.manifest(encoded)
            # 先载荷、后清单，只有最后一次 rename 才提交；半成品/取消任务不会成为 TS 候选。
            payload_temp = self.root / (PAYLOAD + ".tmp")
            with payload_temp.open("xb") as stream:
                owned.add(payload_temp)
                digest = hashlib.sha256()

                def write(data):
                    stream.write(data)
                    digest.update(data)

                def write_values(entry, values):
                    padding = entry["byteOffset"] - stream.tell()
                    require(0 <= padding < 8, "UV 缓存写入偏移不一致")
                    write(b"\0" * padding)
                    numeric = np.asarray(values, dtype=DTYPES[entry["type"]])
                    require(numeric.size == entry["length"], "UV 缓存写入数量不一致")
                    raw = memoryview(numeric).cast("B")
                    for start in range(0, len(raw), self.control["chunkBytes"]):
                        write(raw[start:start + self.control["chunkBytes"]])

                write(b"BLUV0001")
                for source, obj, row in zip(sources, objects, rows):
                    for field, entry in row["attributes"].items():
                        write_values(entry, source[field])
                    loops = np.empty(len(obj.data.loops), dtype=np.uint32)
                    obj.data.loops.foreach_get("vertex_index", loops)
                    write_values(row["loopVertices"], loops)
                    write_values(row["winding"], obj["source_winding_flipped"])
                    uvs = np.empty(len(obj.data.loops) * 2, dtype=np.float32)
                    obj.data.uv_layers["LightmapUV"].data.foreach_get("uv", uvs)
                    write_values(row["lightmapUvs"], uvs)
                require(stream.tell() == offset, "UV 缓存写入长度不一致")
                stream.flush()
                os.fsync(stream.fileno())
            record["payload"]["sha256"] = digest.hexdigest()
            encoded = json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            manifest_temp = self.root / (MANIFEST + ".tmp")
            with manifest_temp.open("xb") as stream:
                owned.add(manifest_temp)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            for name in (PAYLOAD, MANIFEST):
                destination = self.root / name
                if destination.exists() or destination.is_symlink():
                    require(stat.S_ISREG(destination.lstat().st_mode) and not destination.is_symlink(), "UV 缓存提交目标不是普通文件")
            payload_temp.replace(self.root / PAYLOAD)
            owned.remove(payload_temp)
            manifest_temp.replace(self.root / MANIFEST)
            owned.remove(manifest_temp)
            self.diagnostic["bytes"] = offset + len(encoded)
            self.diagnostic["reason"] += "；已保存本任务 packed UV/布局包"
        except Exception as error:
            self.diagnostic["reason"] += "；未保存可选缓存：" + str(error)
        finally:
            for file in owned:
                try:
                    file.unlink()
                except OSError:
                    pass
            self.inputs = []
            self.diagnostic["writeDurationMs"] = round((time.monotonic() - started) * 1000)
            self.emit()
