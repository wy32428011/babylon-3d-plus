// 虚拟输送线（virtual-conveyor.glb）参数化脚本。
//
// 【文件结构】
//   1. dataDriven                     — 运行时运动语义（conveyor 货物走行），编辑器静态解析，勿删。
//   2. ParametricModelParamsComponent — Inspector 侧边栏参数定义，值写入 metadata。
//   3. ParametricModelRuntimeComponent— 参数签名变化时恢复基线并重放：整板缩放到 length×0.05×width + 材质乘色。
//
// 【说明】
//   - GLB 为 1×0.05×1 m 扁平长方体，单 mesh 命名 VCConveyorBelt，几何原点在底面中心。
//   - 长度/宽度缩放绕节点原点，底面贴地、平面居中；厚度固定 0.05 m。
//   - 货物支撑面走 conveyorDriver 包围盒顶面兜底（= 板顶 0.05 m），无需脚本写 metadata。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { visibleAsColor3, visibleAsNumber } from "babylonjs-editor-tools";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** 声明虚拟输送线的数据驱动语义，编辑器导入时会静态解析该对象。 */
export const dataDriven = {
	device: {
		devType: "conveyor",
		defaultAssetCode: "VirtualConveyor"
	},
	cargo: {
		travel: {
			axis: "x",
			speed: 0.3,
			nodes: []
		}
	}
} as const;

/** 管理虚拟输送线在 Babylon.js Editor Inspector 中展示的静态参数。 */
export class ParametricModelParamsComponent {
	@visibleAsNumber("长度", { min: 0.1, max: 100, step: 0.01 })
	public length: number = 2;

	@visibleAsNumber("宽度", { min: 0.1, max: 100, step: 0.01 })
	public width: number = 1;

	@visibleAsColor3("颜色", { description: "默认 #8a97a5" })
	public color: Color3 = Color3.FromHexString("#8a97a5");

	/** 创建虚拟输送线参数配置组件。 */
	public constructor(public node: TransformNode) { }

	/** 参数组件只负责保存 Inspector 字段，运行时由 ParametricModelRuntimeComponent 读取并应用。 */
	public onStart(): void {
		// 静态参数会保存到 metadata.scripts[].values，供同目录运行脚本读取。
	}
}

type ValueMap = Record<string, unknown>;

/** 与 ParametricModelParamsComponent 及 meta.json 保持一致的默认值。 */
const DEFAULT_VALUES: ValueMap = {
	length: 2,
	width: 1,
	color: "#8a97a5"
};

/** 输送板 mesh 节点名（命中 conveyorDriver 行程节点兜底正则）。 */
const BELT_NODE_NAME = "VCConveyorBelt";

/** 根据 Inspector 参数对虚拟输送线执行静态参数化调整。 */
export class ParametricModelRuntimeComponent {
	private baselineXSpanMeters = 0;
	private baselineZSpanMeters = 0;
	private readonly appearanceMaterials = new Map<string, any>();
	private lastSignature = "";

	public length: number = Number(DEFAULT_VALUES.length);
	public width: number = Number(DEFAULT_VALUES.width);
	public color: Color3 = Color3.FromHexString(String(DEFAULT_VALUES.color));

	/** 创建虚拟输送线静态参数化运行组件。 */
	public constructor(public node: TransformNode) { }

	/** 启动时记录基线尺寸，并立即应用当前静态参数。 */
	public onStart(): void {
		const belt = this.findBeltNode();
		if (belt) {
			this.baselineXSpanMeters = this.getNodeMeterAxisSize(belt, "x") || 1;
			this.baselineZSpanMeters = this.getNodeMeterAxisSize(belt, "z") || 1;
		}
		this.applyIfNeeded(true);
	}

	/** 每帧检测参数签名变化，变化后重新应用。 */
	public onUpdate(): void {
		this.applyIfNeeded(false);
	}

	/** 停止脚本时恢复模型导入时的基础状态。 */
	public onStop(): void {
		this.disposeAppearanceMaterials();
		this.lastSignature = "";
	}

	/** 在参数变化或强制刷新时重新应用虚拟输送线规则。 */
	private applyIfNeeded(force: boolean): void {
		const values = this.readParamValues();
		const signature = JSON.stringify(values);
		if (!force && signature === this.lastSignature) {
			return;
		}

		this.applyModelParameters(values);
		this.lastSignature = signature;
	}

	/** 虚拟输送线参数化：整体缩放到目标长宽 + 材质乘色。 */
	private applyModelParameters(values: ValueMap): void {
		const belt = this.findBeltNode();
		if (belt) {
			const lengthScale = this.readPositiveNumber(values, "length", this.baselineXSpanMeters) / this.baselineXSpanMeters;
			const widthScale = this.readPositiveNumber(values, "width", this.baselineZSpanMeters) / this.baselineZSpanMeters;
			if (Math.abs(lengthScale - 1) > 1e-6 || Math.abs(widthScale - 1) > 1e-6) {
				// 几何原点在底面中心：绕原点缩放保持贴地且长宽居中。
				belt.scaling = new Vector3(lengthScale, 1, widthScale);
			} else {
				belt.scaling = new Vector3(1, 1, 1);
			}
		}
		this.applyColor(values);
	}

	/** 颜色应用到输送板 mesh（节点自身即 mesh 时一并处理）：克隆基线材质去纹理后乘色，黑色表示保留原色。 */
	private applyColor(values: ValueMap): void {
		const belt = this.findBeltNode();
		if (!belt) {
			return;
		}
		const meshes = [
			...(this.isColorableMesh(belt) ? [belt] : []),
			...(typeof belt.getChildMeshes === "function" ? belt.getChildMeshes(false) : []),
		];
		const tint = this.normalizeColor(this.readColor(values));
		meshes.forEach((mesh: any) => {
			if (!this.isColorableMesh(mesh)) {
				return;
			}
			const baseMaterial = this.rememberBaseMaterial(mesh);
			if (!tint) {
				if (baseMaterial !== undefined) {
					mesh.material = baseMaterial;
				}
				return;
			}
			const appearanceMaterial = this.getOrCreateAppearanceMaterial(baseMaterial);
			if (!appearanceMaterial) {
				return;
			}
			if (appearanceMaterial.albedoColor?.copyFrom) {
				appearanceMaterial.albedoColor.copyFrom(tint);
			}
			if (appearanceMaterial.diffuseColor?.copyFrom) {
				appearanceMaterial.diffuseColor.copyFrom(tint);
			}
			if (mesh.useVertexColors === true) {
				mesh.useVertexColors = false;
			}
			mesh.material = appearanceMaterial;
		});
	}

	/** 首次访问时记录 mesh 的基线材质，供恢复原始颜色使用。 */
	private rememberBaseMaterial(mesh: any): any {
		if (!this.snapshotMaterials.has(mesh)) {
			this.snapshotMaterials.set(mesh, "material" in mesh ? mesh.material : undefined);
		}
		return this.snapshotMaterials.get(mesh);
	}

	private readonly snapshotMaterials = new Map<any, any>();

	private findBeltNode(): any {
		const nodes = [
			...(this.node.getScene?.().transformNodes ?? []),
			...(this.node.getScene?.().meshes ?? []),
		];
		return nodes.find((candidate) => candidate !== this.node && String(candidate.name ?? "") === BELT_NODE_NAME)
			?? null;
	}

	/** 返回节点在 entityRoot 米空间下指定轴的包围盒长度。 */
	private getNodeMeterAxisSize(target: any, axis: "x" | "y" | "z"): number {
		const bounds = this.getNodeMeterBounds(target);
		return bounds ? Math.max(0, bounds.maximum[axis] - bounds.minimum[axis]) : 0;
	}

	/** 合并子 mesh 包围盒，得到节点在 entityRoot 米空间下的 AABB。 */
	private getNodeMeterBounds(target: any): { minimum: Vector3; maximum: Vector3 } | null {
		const meshes: any[] = [];
		if (this.isBoundsMesh(target)) {
			meshes.push(target);
		}
		if (typeof target?.getChildMeshes === "function") {
			meshes.push(...target.getChildMeshes(false).filter((child: any) => this.isBoundsMesh(child)));
		}
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const inverseMatrix = entityRootWorldMatrix?.clone?.();
		if (meshes.length === 0 || !inverseMatrix?.invert) {
			return null;
		}
		inverseMatrix.invert();
		let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		meshes.forEach((mesh) => {
			mesh.refreshBoundingInfo?.();
			mesh.computeWorldMatrix?.(true);
			const corners = mesh.getBoundingInfo?.().boundingBox?.vectorsWorld ?? [];
			corners.forEach((corner: Vector3) => {
				const meterPoint = Vector3.TransformCoordinates(corner, inverseMatrix);
				minimum = Vector3.Minimize(minimum, meterPoint);
				maximum = Vector3.Maximize(maximum, meterPoint);
			});
		});
		return Number.isFinite(minimum.x) && Number.isFinite(maximum.x) ? { minimum, maximum } : null;
	}

	private isBoundsMesh(node: any): boolean {
		return typeof node?.getBoundingInfo === "function"
			&& !node.isDisposed?.()
			&& node.isEnabled?.(false) !== false
			&& node.isVisible !== false
			&& Number(node.visibility ?? 1) > 0
			&& Number(node.getTotalVertices?.() ?? 0) > 0;
	}

	private isColorableMesh(target: any): boolean {
		return !target?.isDisposed?.()
			&& typeof target.getTotalVertices === "function"
			&& target.getTotalVertices() > 0
			&& "material" in target;
	}

	private readColor(values: ValueMap): Color3 {
		const raw = values.color;
		if (raw instanceof Color3) {
			return raw;
		}
		if (typeof raw === "string") {
			const normalized = raw.startsWith("#") ? raw : `#${raw}`;
			try {
				return Color3.FromHexString(normalized);
			} catch {
				return Color3.FromHexString(String(DEFAULT_VALUES.color));
			}
		}
		return Color3.FromHexString(String(DEFAULT_VALUES.color));
	}

	/** (0,0,0) 表示保留原色。 */
	private normalizeColor(color: Color3): Color3 | null {
		if (color.r === 0 && color.g === 0 && color.b === 0) {
			return null;
		}
		return new Color3(
			Math.min(1, Math.max(0, color.r)),
			Math.min(1, Math.max(0, color.g)),
			Math.min(1, Math.max(0, color.b))
		);
	}

	private getOrCreateAppearanceMaterial(baseMaterial: any): any | null {
		if (!baseMaterial) {
			return null;
		}
		const cacheKey = String(baseMaterial.uniqueId ?? baseMaterial.id ?? baseMaterial.name ?? "material");
		const cachedMaterial = this.appearanceMaterials.get(cacheKey);
		if (cachedMaterial) {
			return cachedMaterial;
		}
		if (typeof baseMaterial.clone !== "function") {
			return null;
		}
		const clonedMaterial = baseMaterial.clone(`${String(baseMaterial.name ?? "material")}_vc_${this.appearanceMaterials.size}`);
		if (!clonedMaterial) {
			return null;
		}
		this.stripAppearanceMaterialTextures(clonedMaterial);
		this.appearanceMaterials.set(cacheKey, clonedMaterial);
		return clonedMaterial;
	}

	private stripAppearanceMaterialTextures(material: any): void {
		[
			"albedoTexture", "diffuseTexture", "emissiveTexture", "ambientTexture", "opacityTexture",
			"lightmapTexture", "reflectionTexture", "reflectivityTexture", "metallicTexture",
			"roughnessTexture", "microSurfaceTexture", "bumpTexture", "normalTexture", "specularTexture"
		].forEach((key) => {
			if (key in material) {
				material[key] = null;
			}
		});
	}

	private disposeAppearanceMaterials(): void {
		this.appearanceMaterials.forEach((material) => {
			if (typeof material?.dispose === "function" && material.isDisposed?.() !== true) {
				material.dispose();
			}
		});
		this.appearanceMaterials.clear();
		this.snapshotMaterials.clear();
	}

	/** 合并默认值、metadata 脚本值与运行时实例字段，得到当前有效参数表。 */
	private readParamValues(): ValueMap {
		const scriptValues = this.readScriptParamValues();
		const mergedValues = { ...DEFAULT_VALUES, ...scriptValues };
		return Object.keys(mergedValues).reduce((result: ValueMap, key) => {
			result[key] = this.readRuntimeValue(key, mergedValues[key]);
			return result;
		}, {});
	}

	/** 优先读取编辑器注入到运行实例上的实时参数，未注入时保留 metadata 中的参数值。 */
	private readRuntimeValue(key: string, fallback: unknown): unknown {
		const value = (this as Record<string, unknown>)[key];
		return value === undefined ? fallback : value;
	}

	/** 从 metadata.scripts[] 中读取 ParametricModelParamsComponent 保存的 values。 */
	private readScriptParamValues(): ValueMap {
		const scripts = Array.isArray(this.node.metadata?.scripts) ? this.node.metadata.scripts : [];
		for (const script of scripts) {
			const scriptName = String(script?.className ?? script?.name ?? script?.scriptFilename ?? "");
			const values = {
				...this.normalizeValueMap(script?.values),
				...this.normalizeValueMap(script?.properties),
				...this.normalizeValueMap(script?.config)
			};
			if (scriptName.includes("ParametricModelParamsComponent") || Object.keys(values).some((key) => key in DEFAULT_VALUES)) {
				return values;
			}
		}
		return {};
	}

	/** 将 values / properties / config 等多种存储格式统一为 key-value 映射。 */
	private normalizeValueMap(source: unknown): ValueMap {
		if (!source || typeof source !== "object") {
			return {};
		}
		if (Array.isArray(source)) {
			return source.reduce((result: ValueMap, item: any) => {
				const key = String(item?.key ?? item?.propertyKey ?? item?.name ?? "");
				if (key) {
					result[key] = item.value ?? item.currentValue ?? item.defaultValue;
				}
				return result;
			}, {});
		}
		return Object.entries(source as Record<string, unknown>).reduce((result: ValueMap, [key, value]) => {
			if (value && typeof value === "object") {
				const record = value as Record<string, unknown>;
				if ("value" in record || "currentValue" in record || "defaultValue" in record) {
					result[key] = record.value ?? record.currentValue ?? record.defaultValue;
					return result;
				}
			}
			result[key] = value;
			return result;
		}, {});
	}

	/** 读取正数参数，非正数时返回 fallback。 */
	private readPositiveNumber(values: ValueMap, key: string, fallback: number): number {
		const value = Number(values[key]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	}
}
