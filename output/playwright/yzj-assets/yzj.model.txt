// 此文件由模型包参数脚本和运行脚本合并而成，供编辑器以单个 TS 文件读取。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import { visibleAsBoolean, visibleAsNumber, visibleAsString } from "babylonjs-editor-tools";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// 参数长度统一使用米；contentRoot 的基础 scaling 已由编辑器包含源单位换算。

/**
 * 声明一体式顶升移载的数据驱动运动语义，编辑器导入时会静态解析该对象。
 */
export const dataDriven = {
	device: {
		devType: "conveyor",
		defaultAssetCode: "YZJ01",
		deviceIdField: "e",
		assetCodeField: "assetCode",
		interpolationMs: 200
	},
	motion: {
		lift: {
			fields: ["movement_y"],
			kind: "translate",
			axis: "y",
			valueMode: "action",
			actionMap: {"0": 0, "1": 1, "2": -1},
			speed: 0.2,
			nodes: ["GT.3", "Ban.4"],
			limits: { min: 0, max: 0.6 }
		},
		roller: {
			fields: ["movement_x", "rotation"],
			kind: "rotate",
			axis: "x",
			valueMode: "action",
			actionMap: {"0": 0, "1": 1, "2": -1},
			speed: 360,
			nodes: ["GT.3"]
		}
	}
} as const;

/**zhi
 * 管理 一体式顶升移载 在 Babylon.js Editor Inspector 中展示的静态参数。
 */
export class ParametricModelParamsComponent {
	@visibleAsNumber("长度", { step: 0.0001 })
	public length: number = 1.8276;

	@visibleAsNumber("宽度", { step: 0.0001 })
	public width: number = 1.0621;

	@visibleAsNumber("高度", { step: 0.0000001 })
	public height: number = 0.6478692;

	@visibleAsString("主体颜色")
	public bodyColor: string = "#387368";

	@visibleAsNumber("辊筒框架位置", { step: 0.0000001 })
	public rollerFramePosition: number = 1;

	@visibleAsNumber("辊筒框架长度", { step: 0.000001 })
	public rollerFrameLength: number = 1.021932;

	@visibleAsNumber("电机位置", { step: 0.0000001 })
	public motorPosition: number = 0;

	@visibleAsNumber("辊筒密度", { step: 0.1 })
	public rollerDensity: number = 0.6;

	@visibleAsBoolean("显示腿A")
	public showLegA: boolean = true;

	@visibleAsBoolean("显示腿B")
	public showLegB: boolean = true;

	@visibleAsBoolean("显示电机")
	public showMotor: boolean = true;

	@visibleAsBoolean("辊轮皮")
	public rollerSkin: boolean = true;

	/**
	 * 创建 一体式顶升移载 参数配置组件。
	 * @param node 当前脚本绑定的模型根节点。
	 */
	public constructor(public node: TransformNode) {}

	/**
	 * 参数组件只负责保存 Inspector 字段，运行时由 ParametricModelRuntimeComponent 读取并应用。
	 */
	public onStart(): void {
		// 静态参数会保存到 metadata.scripts[].values，供同目录运行脚本读取。
	}
}

type ValueMap = Record<string, unknown>;
type AxisName = "x" | "y" | "z";
type TransferSide = "left" | "right" | "front" | "rear";

interface NodeSnapshot {
	position: Vector3;
	scaling: Vector3;
	rotation?: Vector3;
	rotationQuaternion?: any;
	enabled?: boolean;
	vertexPositions?: number[];
	material?: any;
}

interface MeshComponentSnapshot {
	vertexIndices: number[];
	minimum: Vector3;
	maximum: Vector3;
	center: Vector3;
	size: Vector3;
	faceCount: number;
}

interface ResolvedDimension {
	value: number;
	baseline: number;
	ratio: number;
	usesLegacyValue: boolean;
}

const DEFAULT_VALUES: ValueMap = {
	"length": 1.8276,
	"width": 1.0621,
	"height": 0.6478692,
	"bodyColor": "#387368",
	"rollerFramePosition": 0,
	"rollerFrameLength": 1.021932,
	"motorPosition": 0,
	"rollerDensity": 0.6,
	"showLegA": true,
	"showLegB": true,
	"showMotor": true,
	"rollerSkin": true,
	// 以下字段保留旧场景、物流方向和运行态箭头兼容，不再作为主参数面板字段展示。
	"modelKey": "yzj",
	"deviceType": "输送",
	"deviceName": "一体式顶升移载",
	"description": "支持图片参数中的整机尺寸、主体颜色、辊筒框架、电机、腿 A/B 与辊轮皮控制。",
	"chainLength": 1.828,
	"platformLength": 1.022,
	"platformPosition": 0,
	"chainWidth": 1.194,
	"chainHeight": 0.803,
	"rollerWidth": 0.062,
	"rollerPosition": 0,
	"infeedSide": "left",
	"outfeedSide": "front",
	"frontSide": "right",
	"backSide": "left",
	"showDirectionArrow": true,
	"directionArrowImage": "editor-image://builtin/direction-arrow-glow",
	"showFrontSupport": true,
	"showRearSupport": true
};

const BODY_NODE_NAME = "ZT.2";
const ROLLER_NODE_NAME = "GT.3";
const PLATFORM_NODE_NAME = "Ban.4";
const PARAMETER_EPSILON = 0.0000001;

/**
 * 根据 Inspector 参数对 一体式顶升移载 执行静态参数化调整。
 */
export class ParametricModelRuntimeComponent {
	private readonly snapshots = new Map<any, NodeSnapshot>();
	private readonly meshComponents = new Map<any, MeshComponentSnapshot[]>();
	private readonly generatedNodes: any[] = [];
	private readonly generatedMaterials: any[] = [];
	private readonly flowMetadataSnapshots = new Map<any, unknown>();
	private readonly startupValues: ValueMap;
	private directionArrowMesh: any | null = null;
	private directionArrowMaterial: any | null = null;
	private directionArrowTexture: any | null = null;
	private directionArrowObserver: any | null = null;
	private directionArrowTextureUrl = "";
	private directionArrowFailedTextureUrl = "";
	private lastSignature = "";

	/**
	 * 创建 一体式顶升移载 静态参数化运行组件。
	 * @param node 当前脚本绑定的模型根节点。
	 */
	public constructor(public node: TransformNode) {
		// Play/导出运行时可能会在 onStart 前整理 metadata.scripts，因此构造时先缓存一次参数值。
		this.startupValues = this.readParamValuesFromMetadata();
	}

	/**
	 * 启动时记录原始状态，并立即应用当前静态参数。
	 */
	public onStart(): void {
		this.captureSnapshots();
		this.applyIfNeeded(true);
	}

	/**
	 * 每帧检测参数签名变化，并刷新运行态方向箭头。
	 */
	public onUpdate(): void {
		this.applyIfNeeded(false);
		this.updateDirectionArrowVisual(this.readParamValues());
	}

	/**
	 * 停止脚本时清理生成节点、箭头资源，并恢复模型导入时的基础状态。
	 */
	public onStop(): void {
		this.disposeDirectionArrowResources();
		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
		this.disposeGeneratedMaterials();
		this.restoreFlowMetadata();
		this.lastSignature = "";
	}

	/**
	 * dispose 生命周期同样释放方向箭头，兼容编辑器卸载脚本实例。
	 */
	public dispose(): void {
		this.onStop();
	}

	/**
	 * onDispose 生命周期同样释放方向箭头，避免预览停止后遗留 observer。
	 */
	public onDispose(): void {
		this.onStop();
	}

	/**
	 * onUnload 生命周期同样释放方向箭头，兼容外置脚本热卸载。
	 */
	public onUnload(): void {
		this.onStop();
	}

	/**
	 * 在参数变化或强制刷新时重新应用全部静态参数。
	 */
	private applyIfNeeded(force: boolean): void {
		const values = this.readParamValues();
		const signature = JSON.stringify(values);
		if (!force && signature === this.lastSignature) { return; }
		this.disposeDirectionArrowResources();
		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
		this.disposeGeneratedMaterials();
		this.applyYZJParameters(values);
		this.lastSignature = signature;
	}

	/**
	 * 记录当前模型根节点和所有子节点的基础变换与启用状态。
	 */
	private captureSnapshots(): void {
		this.getModelNodes().forEach((target) => this.rememberSnapshot(target));
	}

	/**
	 * 保存单个节点的基础状态，后续所有参数应用都以该状态为基线。
	 */
	private rememberSnapshot(target: any): NodeSnapshot {
		if (!this.snapshots.has(target)) {
			this.snapshots.set(target, {
				position: target.position?.clone?.() ?? Vector3.Zero(),
				scaling: target.scaling?.clone?.() ?? new Vector3(1, 1, 1),
				rotation: target.rotation?.clone?.(),
				rotationQuaternion: target.rotationQuaternion?.clone?.(),
				enabled: typeof target.isEnabled === "function" ? target.isEnabled() : undefined,
				vertexPositions: this.readVertexPositions(target),
				material: "material" in target ? target.material : undefined,
			});
		}
		return this.snapshots.get(target) ?? { position: Vector3.Zero(), scaling: new Vector3(1, 1, 1) };
	}

	/**
	 * 将所有已记录节点恢复到导入时的基础状态。
	 */
	private restoreBaseNodes(): void {
		this.snapshots.forEach((snapshot, target) => {
			if (target.position) { target.position = snapshot.position.clone(); }
			if (target.scaling) { target.scaling = snapshot.scaling.clone(); }
			if (target.rotation && snapshot.rotation) { target.rotation = snapshot.rotation.clone(); }
			if (snapshot.rotationQuaternion && target.rotationQuaternion !== undefined) { target.rotationQuaternion = snapshot.rotationQuaternion.clone(); }
			if (snapshot.vertexPositions) { this.restoreVertexPositions(target, snapshot.vertexPositions); }
			if (snapshot.material !== undefined && "material" in target) { target.material = snapshot.material; }
			if (snapshot.enabled !== undefined && typeof target.setEnabled === "function") { target.setEnabled(snapshot.enabled); }
		});
	}

	/**
	 * 读取 mesh 的原始顶点坐标，用于恢复基线和计算节点局部中心。
	 */
	private readVertexPositions(target: any): number[] | undefined {
		if (typeof target.getVerticesData !== "function") { return undefined; }
		const positions = target.getVerticesData("position");
		return positions ? Array.from(positions as ArrayLike<number>) : undefined;
	}

	/**
	 * 恢复 mesh 的原始顶点坐标并刷新包围盒。
	 */
	private restoreVertexPositions(target: any, positions: number[]): void {
		if (typeof target.setVerticesData !== "function") { return; }
		target.setVerticesData("position", positions.slice(), true);
		this.refreshMeshBounds(target);
	}

	/**
	 * 从模型 metadata、启动缓存和外置脚本实例注入中读取 Inspector 参数。
	 */
	private readParamValues(): ValueMap {
		return { ...DEFAULT_VALUES, ...this.filterKnownValues(this.startupValues), ...this.readParamValuesFromMetadata(), ...this.readInjectedParameterValues() };
	}

	/**
	 * 从模型 metadata 中读取参数脚本保存的 values，metadata 缺失时返回空对象。
	 */
	private readParamValuesFromMetadata(): ValueMap {
		const scripts = Array.isArray(this.node.metadata?.scripts) ? this.node.metadata.scripts : [];
		for (const script of scripts) {
			const scriptName = String(script?.className ?? script?.name ?? script?.scriptFilename ?? "");
			const values = this.filterKnownValues({ ...this.readFieldDefaults(script), ...this.normalizeValueMap(script?.values), ...this.normalizeValueMap(script?.properties), ...this.normalizeValueMap(script?.config) });
			if (scriptName.includes("ParametricModelParamsComponent") || Object.keys(values).length > 0) { return values; }
		}
		return {};
	}

	/**
	 * 读取 meta 字段列表中的默认值，保证 Inspector 尚未保存时也能取得参数。
	 */
	private readFieldDefaults(script: any): ValueMap {
		const fields = Array.isArray(script?.fields) ? script.fields : [];
		return fields.reduce((result: ValueMap, field: any) => {
			const key = String(field?.key ?? field?.propertyKey ?? "");
			if (key) { result[key] = field.defaultValue ?? field.value; }
			return result;
		}, {});
	}

	/**
	 * 将 values/properties/config 的包装结构转换为普通键值表。
	 */
	private normalizeValueMap(source: unknown): ValueMap {
		if (!source || typeof source !== "object") { return {}; }
		if (Array.isArray(source)) {
			return source.reduce((result: ValueMap, item: any) => {
				const key = String(item?.key ?? item?.propertyKey ?? item?.name ?? "");
				if (key) { result[key] = item.value ?? item.currentValue ?? item.defaultValue; }
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

	/**
	 * 只读取 DEFAULT_VALUES 已声明的运行时字段，避免 metadata 中的无关键覆盖参数契约。
	 */
	private filterKnownValues(source: ValueMap): ValueMap {
		return Object.keys(DEFAULT_VALUES).reduce((result: ValueMap, key) => {
			if (key in source) { result[key] = source[key]; }
			return result;
		}, {});
	}

	/**
	 * 读取 ExternalModelScriptRuntime 注入到实例上的当前参数值，优先级高于 metadata 快照。
	 */
	private readInjectedParameterValues(): ValueMap {
		const instance = this as unknown as ValueMap;
		return Object.keys(DEFAULT_VALUES).reduce((result: ValueMap, key) => {
			if (instance[key] !== undefined) { result[key] = instance[key]; }
			return result;
		}, {});
	}

	/**
	 * 按 YZJ.glb 的真实结构应用参数，避免旧模板对整机根节点做二次缩放。
	 */
	private applyYZJParameters(values: ValueMap): void {
		const length = this.resolveDimensionParameter(values, "length", 1.8276, "chainLength", 1.828);
		const width = this.resolveDimensionParameter(values, "width", 1.0621, "chainWidth", 1.194);
		const height = this.resolveDimensionParameter(values, "height", 0.6478692, "chainHeight", 0.803);
		const frameLengthRaw = this.resolveDimensionParameter(values, "rollerFrameLength", 1.021932, "platformLength", 1.022);
		// 拉伸实际目标：参数值 + 0.12m。
		const frameLengthValue = frameLengthRaw.value - 0.12;
		const frameLengthRatio = frameLengthValue / frameLengthRaw.baseline;

		const heightLift = this.applyBodyParameters(length.ratio, width.ratio, height.ratio);
		const framePosition = this.applyPlatformParameters(values, frameLengthRatio, width.ratio, heightLift);
		this.applyRollerParameters(values, frameLengthRatio, heightLift, framePosition, width.value);
		this.applyMotorParameters(values, width.ratio);
		this.applySupportVisibility(values);
		this.applyBodyColor(values);
		this.applyFlowDirection(values);
		this.updateDirectionArrowVisual(values);
	}

	/**
	 * 链条机主体 ZT.2：长度/宽度顶点拉伸；高度拉立柱后非腿部件上移。返回高度上移量供 Ban.4/辊筒同步。
	 */
	private applyBodyParameters(lengthRatio: number, widthRatio: number, heightRatio: number): number {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return 0; }
		this.stretchBodyLength(body, lengthRatio);
		this.stretchBodyWidth(body, widthRatio);
		return this.stretchBodyHeight(body, heightRatio);
	}

	/**
	 * 主体长度分段拉伸：电机仓整段（含台面下电机盒）固定，仅仓外台面单向伸长。
	 */
	private stretchBodyLength(body: any, lengthRatio: number): void {
		if (Math.abs(lengthRatio - 1) < 0.0001) { return; }
		const meshes = this.getMeshesForNodes([body]);
		const bounds = this.getLocalVertexBounds(meshes, "x");
		if (!bounds) { return; }
		const sourceLength = bounds.max - bounds.min;
		if (sourceLength <= 0) { return; }
		const otherCapLength = this.getProtectedBodyEndLength(sourceLength);
		const middleStart = this.getMotorBayProtectEndX(meshes, bounds, sourceLength);
		const middleEnd = bounds.max - otherCapLength;
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const requestedLength = sourceLength * lengthRatio;
		const protectedSpan = (middleStart - bounds.min) + otherCapLength;
		const targetLength = Math.max(requestedLength, protectedSpan + Math.min(0.08, sourceLength * 0.08));
		const extension = targetLength - sourceLength;
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchMeshVerticesByLocalX(mesh, middleStart, middleEnd, middleScale, extension));
	}

	/**
	 * 高度：四根立柱脚底锚定向上/向下拉；腿显隐中偏上的横梁等随台移动，最下方脚件不动；其余非腿零件同步。
	 * @returns Y 位移（局部，可正可负），供 Ban.4/辊筒同步。
	 */
	private stretchBodyHeight(body: any, heightRatio: number): number {
		if (Math.abs(heightRatio - 1) < 0.0001) { return 0; }
		const meshes = this.getMeshesForNodes([body]);
		let heightLift = 0;
		meshes.forEach((mesh) => {
			const components = this.getMeshComponents(mesh);
			const legComponents = components.filter((component) => this.isLegAComponent(component) || this.isLegBComponent(component));
			const pillars = [
				...this.pickLegPillarsToStretch(components.filter((component) => this.isLegAComponent(component))),
				...this.pickLegPillarsToStretch(components.filter((component) => this.isLegBComponent(component))),
			];
			if (pillars.length === 0) { return; }
			const baseline = this.rememberSnapshot(mesh).vertexPositions;
			if (!baseline || typeof mesh.setVerticesData !== "function") { return; }
			const current = this.readVertexPositions(mesh) ?? baseline;
			const nextPositions = current.slice();
			// 有符号位移：变高为正、变矮为负（不能用 Math.max 夹到 0）。
			const meshLift = Math.max(...pillars.map((pillar) => pillar.size.y)) * (heightRatio - 1);
			const pillarVertices = new Set<number>();
			pillars.forEach((pillar) => {
				const bottomY = pillar.minimum.y;
				pillar.vertexIndices.forEach((vertexIndex) => {
					pillarVertices.add(vertexIndex);
					const offset = vertexIndex * 3;
					const y = baseline[offset + 1];
					nextPositions[offset + 1] = bottomY + (y - bottomY) * heightRatio;
				});
			});
			if (Math.abs(meshLift) > Math.abs(heightLift)) {
				heightLift = meshLift;
			}

			const pillarBottom = Math.min(...pillars.map((pillar) => pillar.minimum.y));
			const pillarTop = Math.max(...pillars.map((pillar) => pillar.maximum.y));
			const upperLegMinCenterY = pillarBottom + (pillarTop - pillarBottom) * 0.45;
			const pillarSet = new Set(pillars);
			const lowerLegVertices = new Set<number>();
			legComponents.forEach((component) => {
				if (pillarSet.has(component)) { return; }
				if (component.center.y < upperLegMinCenterY) {
					component.vertexIndices.forEach((vertexIndex) => lowerLegVertices.add(vertexIndex));
				}
			});

			for (let index = 0; index < nextPositions.length; index += 3) {
				const vertexIndex = index / 3;
				if (pillarVertices.has(vertexIndex) || lowerLegVertices.has(vertexIndex)) { continue; }
				nextPositions[index + 1] = baseline[index + 1] + meshLift;
			}
			mesh.setVerticesData("position", nextPositions, true);
			this.refreshMeshBounds(mesh);
		});
		return heightLift;
	}

	/**
	 * 单侧腿组件中选取需要拉高的立柱：优先竖直细长件，取最高的两根（不足则有几根取几根）。
	 */
	private pickLegPillarsToStretch(components: MeshComponentSnapshot[]): MeshComponentSnapshot[] {
		if (components.length === 0) { return []; }
		const columns = components.filter((component) => (
			component.size.y >= component.size.x
			&& component.size.y >= component.size.z
			&& component.size.y >= 0.08
		));
		const pool = columns.length > 0 ? columns : components;
		const ranked = [...pool].sort((left, right) => right.size.y - left.size.y);
		const tallest = ranked[0]?.size.y ?? 0;
		const nearTallest = ranked.filter((component) => component.size.y >= tallest * 0.75);
		if (nearTallest.length >= 2) { return nearTallest.slice(0, 2); }
		return ranked.slice(0, Math.min(2, ranked.length));
	}

	/**
	 * 主体宽度拉伸（局部 Z）：连接左右的横跨件向「非电机端」单向拉长；有电机的一端位置不变。
	 */
	private stretchBodyWidth(body: any, widthRatio: number): void {
		if (Math.abs(widthRatio - 1) < 0.0001) { return; }
		const meshes = this.getMeshesForNodes([body]);
		const bounds = this.getLocalVertexBounds(meshes, "z");
		if (!bounds) { return; }
		const sourceWidth = bounds.max - bounds.min;
		if (sourceWidth <= 0) { return; }
		const capLength = this.getProtectedBodyEndLength(sourceWidth);
		const minMiddle = Math.min(0.12, sourceWidth * 0.12);
		const motorRange = this.getMotorAssemblyZRange(meshes);
		const widthMid = (bounds.min + bounds.max) / 2;
		// 有电机的一端锚定，往另一端拉伸。
		const anchorMinSide = !motorRange || motorRange.center <= widthMid;
		let middleStart = bounds.min + capLength;
		let middleEnd = bounds.max - capLength;
		if (motorRange) {
			if (anchorMinSide) {
				middleStart = Math.max(middleStart, motorRange.max + 0.02);
			} else {
				middleEnd = Math.min(middleEnd, motorRange.min - 0.02);
			}
		}
		if (middleEnd - middleStart < minMiddle) {
			if (anchorMinSide) {
				middleStart = Math.min(middleStart, middleEnd - minMiddle);
				middleStart = Math.max(middleStart, bounds.min + Math.min(capLength, sourceWidth * 0.08));
			} else {
				middleEnd = Math.max(middleEnd, middleStart + minMiddle);
				middleEnd = Math.min(middleEnd, bounds.max - Math.min(capLength, sourceWidth * 0.08));
			}
		}
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const requestedWidth = sourceWidth * widthRatio;
		const protectedSpan = sourceWidth - middleLength;
		const targetWidth = Math.max(requestedWidth, protectedSpan + minMiddle);
		const extension = targetWidth - sourceWidth;
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchMeshVerticesByLocalZ(
			mesh,
			sourceWidth,
			middleStart,
			middleEnd,
			middleScale,
			extension,
			anchorMinSide,
		));
	}

	/** 电机装配局部 Z 范围，用于判定锚定端。 */
	private getMotorAssemblyZRange(meshes: any[]): { min: number; max: number; center: number } | null {
		let motorMinZ = Number.POSITIVE_INFINITY;
		let motorMaxZ = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			this.getMeshComponents(mesh).forEach((component) => {
				if (!this.isMotorComponent(component)) { return; }
				motorMinZ = Math.min(motorMinZ, component.minimum.z);
				motorMaxZ = Math.max(motorMaxZ, component.maximum.z);
			});
		});
		if (!Number.isFinite(motorMinZ) || !Number.isFinite(motorMaxZ)) { return null; }
		return { min: motorMinZ, max: motorMaxZ, center: (motorMinZ + motorMaxZ) / 2 };
	}

	/**
	 * 根据当前 YZJ 主体网格的端部支腿分布计算保护段，避免长度变化时支腿厚度被拉伸。
	 */
	private getProtectedBodyEndLength(sourceLength: number): number {
		return Math.min(sourceLength * 0.22, Math.max(0.28, sourceLength * 0.18));
	}

	/**
	 * 电机仓保护截止 X：覆盖电机本体 + 台面下电机盒，该段整列（含上方台面）不参与拉伸。
	 */
	private getMotorBayProtectEndX(meshes: any[], bounds: { min: number; max: number }, sourceLength: number): number {
		const legCap = this.getProtectedBodyEndLength(sourceLength);
		let protectEnd = bounds.min + legCap;
		let motorMaxX = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			this.getMeshComponents(mesh).forEach((component) => {
				if (this.isMotorComponent(component)) {
					motorMaxX = Math.max(motorMaxX, component.maximum.x);
				}
				if (this.isMotorHousingComponent(component)) {
					protectEnd = Math.max(protectEnd, component.maximum.x + 0.02);
				}
			});
		});
		if (Number.isFinite(motorMaxX)) {
			// 电机盒比电机本体更宽，仅按电机外包会把仓体拉长。
			protectEnd = Math.max(protectEnd, motorMaxX + 0.18, bounds.min + sourceLength * 0.42);
		} else {
			protectEnd = Math.max(protectEnd, bounds.min + Math.min(sourceLength * 0.45, Math.max(0.7, sourceLength * 0.38)));
		}
		const maxProtect = bounds.max - legCap - Math.min(0.08, sourceLength * 0.08);
		return Math.min(protectEnd, maxProtect);
	}

	/**
	 * 将 mesh 的局部 X 顶点映射到端部保护后的目标位置。
	 */
	private stretchMeshVerticesByLocalX(mesh: any, middleStart: number, middleEnd: number, middleScale: number, extension: number): void {
		const positions = this.rememberSnapshot(mesh).vertexPositions;
		if (!positions || typeof mesh.setVerticesData !== "function") { return; }
		const nextPositions = positions.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			const x = positions[index];
			nextPositions[index] = this.mapMotorBayAnchoredLengthX(x, middleStart, middleEnd, middleScale, extension);
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * 固定电机仓侧（局部 X ≤ middleStart），仓外台面中间段拉伸，另一端整体平移。
	 */
	private mapMotorBayAnchoredLengthX(x: number, middleStart: number, middleEnd: number, middleScale: number, extension: number): number {
		if (x <= middleStart) { return x; }
		if (x >= middleEnd) { return x + extension; }
		return middleStart + (x - middleStart) * middleScale;
	}

	/**
	 * 横跨左右的连通组件：Z 向跨度达到整机宽度 40% 以上（横梁、端框等连接两侧的结构）。
	 */
	private isWidthSpanningComponent(component: MeshComponentSnapshot, sourceWidth: number): boolean {
		return component.size.z >= sourceWidth * 0.4;
	}

	/**
	 * 仅横跨左右的组件做宽度分段拉伸；电机保持基线位置；其余非横跨件刚体平移。
	 */
	private stretchMeshVerticesByLocalZ(
		mesh: any,
		sourceWidth: number,
		middleStart: number,
		middleEnd: number,
		middleScale: number,
		extension: number,
		anchorMinSide: boolean,
	): void {
		const baseline = this.rememberSnapshot(mesh).vertexPositions;
		if (!baseline || typeof mesh.setVerticesData !== "function") { return; }
		const current = this.readVertexPositions(mesh) ?? baseline;
		const nextPositions = current.slice();
		const components = this.getMeshComponents(mesh);
		const spanningVertices = new Set<number>();
		const motorVertices = new Set<number>();
		const rigidDeltaByVertex = new Map<number, number>();

		components.forEach((component) => {
			if (this.isMotorComponent(component)) {
				component.vertexIndices.forEach((vertexIndex) => motorVertices.add(vertexIndex));
			}
		});

		components.forEach((component) => {
			if (this.isMotorComponent(component)) { return; }
			if (this.isWidthSpanningComponent(component, sourceWidth)) {
				component.vertexIndices.forEach((vertexIndex) => spanningVertices.add(vertexIndex));
				return;
			}
			const mappedCenter = this.mapMotorSideAnchoredWidthZ(
				component.center.z,
				middleStart,
				middleEnd,
				middleScale,
				extension,
				anchorMinSide,
			);
			const delta = mappedCenter - component.center.z;
			component.vertexIndices.forEach((vertexIndex) => {
				if (!motorVertices.has(vertexIndex) && !spanningVertices.has(vertexIndex)) {
					rigidDeltaByVertex.set(vertexIndex, delta);
				}
			});
		});

		for (let index = 0; index < nextPositions.length; index += 3) {
			const vertexIndex = index / 3;
			const baselineZ = baseline[index + 2];
			if (motorVertices.has(vertexIndex)) {
				nextPositions[index + 2] = baselineZ;
				continue;
			}
			if (spanningVertices.has(vertexIndex)) {
				nextPositions[index + 2] = this.mapMotorSideAnchoredWidthZ(
					baselineZ,
					middleStart,
					middleEnd,
					middleScale,
					extension,
					anchorMinSide,
				);
				continue;
			}
			const rigidDelta = rigidDeltaByVertex.get(vertexIndex);
			if (rigidDelta !== undefined) {
				nextPositions[index + 2] = baselineZ + rigidDelta;
				continue;
			}
			// 未归类顶点：两端随锚定规则平移，中间不拉（避免误拉非连接件）。
			const inMiddle = baselineZ > middleStart && baselineZ < middleEnd;
			nextPositions[index + 2] = inMiddle
				? baselineZ
				: this.mapMotorSideAnchoredWidthZ(
					baselineZ,
					middleStart,
					middleEnd,
					middleScale,
					extension,
					anchorMinSide,
				);
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * 有电机端锚定不动，连接段按比例拉长，另一端整体平移。
	 */
	private mapMotorSideAnchoredWidthZ(
		z: number,
		middleStart: number,
		middleEnd: number,
		middleScale: number,
		extension: number,
		anchorMinSide: boolean,
	): number {
		if (anchorMinSide) {
			if (z <= middleStart) { return z; }
			if (z >= middleEnd) { return z + extension; }
			return middleStart + (z - middleStart) * middleScale;
		}
		if (z >= middleEnd) { return z; }
		if (z <= middleStart) { return z - extension; }
		return middleEnd + (z - middleEnd) * middleScale;
	}

	/**
	 * 辊筒框架位置：相对主体 length 拉伸后物流最左侧（米空间 +X / maximum.x）的偏移；
	 * 0 = Ban.4 的 +X 缘贴齐主体最左侧，再内缩 0.2m。
	 */
	private resolvePlatformPosition(values: ValueMap): number {
		const leftInset = 0.06;
		const requestedFromLeft = this.resolveRollerFrameOffset(values);
		const body = this.findNodeByName(BODY_NODE_NAME);
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (!body || !platform) { return requestedFromLeft + leftInset; }
		const bodyBounds = this.getCurrentNodeMeterBounds(body);
		const platformBounds = this.getCurrentNodeMeterBounds(platform);
		if (!bodyBounds || !platformBounds) { return requestedFromLeft + leftInset; }
		const platformLength = platformBounds.maximum.x - platformBounds.minimum.x;
		const bodyLength = bodyBounds.maximum.x - bodyBounds.minimum.x;
		const maxFromLeft = Math.max(0, bodyLength - platformLength - leftInset);
		const fromLeft = this.clamp(requestedFromLeft, 0, maxFromLeft);
		// 物流左侧 = x+：让平台 maximum.x 对齐「主体 maximum.x - 内缩 - fromLeft」。
		return (bodyBounds.maximum.x - leftInset - fromLeft) - platformBounds.maximum.x;
	}

	/**
	 * 顶升平台 Ban.4：先长度/宽度拉伸，再按「距主体最左侧」定位；返回米制 X 偏移供 GT.3 共用。
	 */
	private applyPlatformParameters(values: ValueMap, platformLengthRatio: number, widthRatio: number, heightOffset: number): number {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (!platform) { return this.resolveRollerFrameOffset(values); }
		this.stretchPlatformLength(platform, platformLengthRatio);
		this.stretchPlatformWidth(platform, widthRatio);
		this.offsetNodeAxis(platform, "y", heightOffset);
		const platformPosition = this.resolvePlatformPosition(values);
		this.addNodeAxisOffset(platform, "x", platformPosition);
		return platformPosition;
	}

	/**
	 * Ban.4 长度：局部 X 最小端（左侧）固定，中间拉伸，最右侧整体 +extension 位移。
	 */
	private stretchPlatformLength(platform: any, lengthRatio: number): void {
		if (Math.abs(lengthRatio - 1) < 0.0001) { return; }
		const meshes = this.getMeshesForNodes([platform]);
		const bounds = this.getLocalVertexBounds(meshes, "x");
		if (!bounds) { return; }
		const sourceLength = bounds.max - bounds.min;
		if (sourceLength <= 0) { return; }
		const capLength = Math.min(this.getProtectedBodyEndLength(sourceLength) * 0.5, sourceLength * 0.12);
		const minMiddle = Math.min(0.08, sourceLength * 0.1);
		let middleStart = bounds.min + capLength;
		let middleEnd = bounds.max - capLength;
		if (middleEnd - middleStart < minMiddle) {
			const mid = (bounds.min + bounds.max) / 2;
			middleStart = mid - minMiddle / 2;
			middleEnd = mid + minMiddle / 2;
		}
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const targetLength = Math.max(sourceLength * lengthRatio, (middleStart - bounds.min) + (bounds.max - middleEnd) + minMiddle);
		const extension = targetLength - sourceLength;
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchMeshVerticesByLocalX(mesh, middleStart, middleEnd, middleScale, extension));
	}

	/**
	 * Ban.4 宽度分段拉伸：锚定端与主体一致；目标宽度对齐主体「横跨连接件」当前跨度
	 * （不对齐主体外包，避免穿出立柱；不按自身倍率，避免基线略短时接不上）。
	 */
	private stretchPlatformWidth(platform: any, widthRatio: number): void {
		if (Math.abs(widthRatio - 1) < 0.0001) { return; }
		const meshes = this.getMeshesForNodes([platform]);
		const bounds = this.getLocalVertexBounds(meshes, "z");
		if (!bounds) { return; }
		const sourceWidth = bounds.max - bounds.min;
		if (sourceWidth <= 0) { return; }
		const capLength = Math.min(this.getProtectedBodyEndLength(sourceWidth) * 0.5, sourceWidth * 0.12);
		const minMiddle = Math.min(0.12, sourceWidth * 0.12);
		const anchorMinSide = this.resolveWidthAnchorMinSide();
		let middleStart = bounds.min + capLength;
		let middleEnd = bounds.max - capLength;
		if (middleEnd - middleStart < minMiddle) {
			const mid = (bounds.min + bounds.max) / 2;
			middleStart = mid - minMiddle / 2;
			middleEnd = mid + minMiddle / 2;
		}
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const protectedSpan = sourceWidth - middleLength;
		const fallbackTarget = Math.max(sourceWidth * widthRatio, protectedSpan + minMiddle);
		const spanningBounds = this.getBodyWidthSpanningLocalZBounds(true);
		const spanningWidth = spanningBounds ? spanningBounds.max - spanningBounds.min : 0;
		// 横跨件宽度作目标；略留缝避免扎进立柱内侧。
		const targetWidth = spanningWidth > sourceWidth * 0.5
			? Math.max(spanningWidth - 0.18, protectedSpan + minMiddle)
			: fallbackTarget;
		const extension = targetWidth - sourceWidth;
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchMeshAllVerticesByLocalZ(
			mesh,
			middleStart,
			middleEnd,
			middleScale,
			extension,
			anchorMinSide,
		));
	}

	/**
	 * 主体中「连接左右」的横跨组件在局部 Z 上的包围（current=true 为拉伸后）。
	 */
	private getBodyWidthSpanningLocalZBounds(current: boolean): { min: number; max: number } | null {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return null; }
		const meshes = this.getMeshesForNodes([body]);
		const fullBounds = this.getLocalVertexBounds(meshes, "z");
		if (!fullBounds) { return null; }
		const sourceWidth = fullBounds.max - fullBounds.min;
		if (sourceWidth <= 0) { return null; }
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = current
				? this.readVertexPositions(mesh)
				: this.rememberSnapshot(mesh).vertexPositions;
			if (!positions) { return; }
			this.getMeshComponents(mesh).forEach((component) => {
				if (!this.isWidthSpanningComponent(component, sourceWidth)) { return; }
				if (!current) {
					min = Math.min(min, component.minimum.z);
					max = Math.max(max, component.maximum.z);
					return;
				}
				component.vertexIndices.forEach((vertexIndex) => {
					const z = positions[vertexIndex * 3 + 2];
					min = Math.min(min, z);
					max = Math.max(max, z);
				});
			});
		});
		return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
	}

	/**
	 * 对 mesh 全部顶点做电机端锚定的 Z 分段映射（用于 Ban.4 必须横跨全宽）。
	 */
	private stretchMeshAllVerticesByLocalZ(
		mesh: any,
		middleStart: number,
		middleEnd: number,
		middleScale: number,
		extension: number,
		anchorMinSide: boolean,
	): void {
		const baseline = this.rememberSnapshot(mesh).vertexPositions;
		if (!baseline || typeof mesh.setVerticesData !== "function") { return; }
		const current = this.readVertexPositions(mesh) ?? baseline;
		const nextPositions = current.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			nextPositions[index + 2] = this.mapMotorSideAnchoredWidthZ(
				baseline[index + 2],
				middleStart,
				middleEnd,
				middleScale,
				extension,
				anchorMinSide,
			);
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/** 宽度锚定端与主体电机所在侧对齐（min-Z 或 max-Z）。 */
	private resolveWidthAnchorMinSide(): boolean {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return true; }
		const bodyMeshes = this.getMeshesForNodes([body]);
		const bounds = this.getLocalVertexBounds(bodyMeshes, "z");
		const motorRange = this.getMotorAssemblyZRange(bodyMeshes);
		if (!bounds || !motorRange) { return true; }
		return motorRange.center <= (bounds.min + bounds.max) / 2;
	}

	/**
	 * 辊筒 GT.3：按「辊筒密度」(中心距, m) 与「宽度」计算根数，固定间距从边沿复制；
	 * 再与 Ban.4 共用长度/X 位置，并按辊筒宽度调单根厚度。
	 */
	private applyRollerParameters(
		values: ValueMap,
		platformLengthRatio: number,
		heightOffset: number,
		platformPosition: number,
		widthMeters: number,
	): void {
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		if (!roller) { return; }
		const rollerWidth = this.readPositiveNumber(values, "rollerWidth", Number(DEFAULT_VALUES.rollerWidth));
		const rollerWidthRatio = rollerWidth / Number(DEFAULT_VALUES.rollerWidth);
		const spacing = Math.max(PARAMETER_EPSILON, this.readPositiveNumber(values, "rollerDensity", Number(DEFAULT_VALUES.rollerDensity)));
		const rollerPosition = this.readNumber(values, "rollerPosition", 0);
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		const platformCurrent = platform ? this.getCurrentNodeMeterBounds(platform) : null;
		const platformBaseline = platform ? this.getNodeMeterBounds(platform) : null;
		const baseCenterZ = this.getNodeMeterCenterAxis(roller, "z") ?? -0.424;
		const preferMinEdge = this.resolveRollerPreferMinWidthEdge(platformBaseline, baseCenterZ);
		// 优先用 Ban.4 当前跨度（已随宽度拉伸）；读不到时回退到宽度参数。
		const spanWidth = platformCurrent
			? Math.max(0, platformCurrent.maximum.z - platformCurrent.minimum.z)
			: Math.max(0, widthMeters);
		const centers = this.createRollerCentersBySpacing(
			platformCurrent,
			spanWidth,
			rollerWidth,
			spacing,
			preferMinEdge,
			baseCenterZ,
		);
		// 厚度可缩放；长度只做顶点拉伸（节点位置不变），规则与主体 length 相同。
		this.scaleNodeWithAxisAnchors(roller, 1, 1, rollerWidthRatio, { z: "center" });
		this.stretchRollerLength(roller, platformLengthRatio);
		this.applyRollerSkin(roller, this.readBoolean(values, "rollerSkin", true));
		const rollerNodes = [roller];
		for (let index = 1; index < centers.length; index += 1) {
			const clone = this.cloneSingleNode(roller, "roller", index);
			if (!clone) { continue; }
			rollerNodes.push(clone);
		}
		rollerNodes.forEach((node, index) => this.placeRollerNode(node, platformPosition + rollerPosition, heightOffset, centers[index] ?? baseCenterZ, baseCenterZ));
	}

	/** 原模型辊筒更靠近 Ban.4 的哪一侧（min-Z / max-Z），宽度变化后仍贴同一侧。 */
	private resolveRollerPreferMinWidthEdge(
		platformBaseline: { minimum: Vector3; maximum: Vector3 } | null,
		rollerCenterZ: number,
	): boolean {
		if (!platformBaseline) { return true; }
		const mid = (platformBaseline.minimum.z + platformBaseline.maximum.z) / 2;
		return rollerCenterZ <= mid;
	}

	/**
	 * 按固定中心距在宽度内排布：count = floor((span - rollerWidth) / spacing) + 1；
	 * 从贴边一端起按 spacing 复制，间距不变（变宽加根数，变窄减根数）。
	 */
	private createRollerCentersBySpacing(
		platformBounds: { minimum: Vector3; maximum: Vector3 } | null,
		spanWidth: number,
		rollerWidth: number,
		spacing: number,
		preferMinEdge: boolean,
		fallbackCenterZ: number,
	): number[] {
		const usable = Math.max(0, spanWidth - rollerWidth);
		const count = this.clamp(Math.floor(usable / spacing) + 1, 1, 80);
		const half = Math.min(rollerWidth / 2, Math.max(0, spanWidth / 2));

		if (!platformBounds) {
			const start = preferMinEdge ? fallbackCenterZ : fallbackCenterZ - (count - 1) * spacing;
			return Array.from({ length: count }, (_, index) => start + index * spacing);
		}

		const minZ = platformBounds.minimum.z;
		const maxZ = platformBounds.maximum.z;
		if (preferMinEdge) {
			const first = minZ + half;
			return Array.from({ length: count }, (_, index) => first + index * spacing);
		}
		const first = maxZ - half;
		return Array.from({ length: count }, (_, index) => first - index * spacing);
	}

	/**
	 * 将辊筒按实体根米空间偏移放到目标位置；辊筒位置沿设备长度方向，密度分布沿设备宽度方向。
	 */
	private placeRollerNode(node: any, xOffsetMeters: number, yOffsetMeters: number, targetCenterZMeters: number, baseCenterZMeters: number): void {
		if (!node.position) { return; }
		const meterOffset = new Vector3(xOffsetMeters, yOffsetMeters, targetCenterZMeters - baseCenterZMeters);
		node.position = node.position.add(this.meterOffsetToParentLocal(node, meterOffset));
	}

	/**
	 * GT.3 长度：与 Ban.4 使用同一绝对伸长量（左固定、中拉、右平移），避免只按自身倍率导致接不上；
	 * 辊轮本体顶点拉伸，辊轮皮只刚体跟随。
	 */
	private stretchRollerLength(roller: any, lengthRatio: number): void {
		const meshes = this.getMeshesForNodes([roller]);
		const bounds = this.getLocalVertexBounds(meshes, "x");
		if (!bounds) { return; }
		const sourceLength = bounds.max - bounds.min;
		if (sourceLength <= 0) { return; }
		const extension = this.resolveRollerLengthExtension(sourceLength, lengthRatio);
		if (Math.abs(extension) < 0.0001) { return; }
		const capLength = Math.min(this.getProtectedBodyEndLength(sourceLength) * 0.5, sourceLength * 0.15);
		const minMiddle = Math.min(0.08, sourceLength * 0.1);
		let middleStart = bounds.min + capLength;
		let middleEnd = bounds.max - capLength;
		if (middleEnd - middleStart < minMiddle) {
			const mid = (bounds.min + bounds.max) / 2;
			middleStart = mid - minMiddle / 2;
			middleEnd = mid + minMiddle / 2;
		}
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchRollerMeshLengthByLocalX(mesh, middleStart, middleEnd, middleScale, extension));
	}

	/**
	 * 优先取 Ban.4 实际伸长量，保证辊筒与框架同步；读不到时回退到自身 lengthRatio。
	 */
	private resolveRollerLengthExtension(rollerSourceLength: number, lengthRatio: number): number {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (platform) {
			const platformMeshes = this.getMeshesForNodes([platform]);
			const baseline = this.getLocalVertexBounds(platformMeshes, "x");
			const current = this.getLocalVertexBounds(platformMeshes, "x", true);
			if (baseline && current) {
				const platformExtension = (current.max - current.min) - (baseline.max - baseline.min);
				if (Number.isFinite(platformExtension)) { return platformExtension; }
			}
		}
		return rollerSourceLength * lengthRatio - rollerSourceLength;
	}

	/**
	 * 仅拉伸辊轮本体；辊轮皮（短轴头/环）按组件中心刚体平移。
	 * 若识别不到本体（如皮与筒焊成一体），整网按 Ban.4 规则拉伸，避免右端只位移一半而悬空。
	 */
	private stretchRollerMeshLengthByLocalX(
		mesh: any,
		middleStart: number,
		middleEnd: number,
		middleScale: number,
		extension: number,
	): void {
		const positions = this.rememberSnapshot(mesh).vertexPositions;
		if (!positions || typeof mesh.setVerticesData !== "function") { return; }
		const nextPositions = positions.slice();
		const components = this.getMeshComponents(mesh);
		const bodyComponents = this.pickRollerBodyComponents(components);
		const bodyVertices = new Set<number>();
		bodyComponents.forEach((component) => {
			component.vertexIndices.forEach((vertexIndex) => bodyVertices.add(vertexIndex));
		});

		if (bodyVertices.size === 0) {
			for (let index = 0; index < nextPositions.length; index += 3) {
				nextPositions[index] = this.mapMotorBayAnchoredLengthX(
					positions[index],
					middleStart,
					middleEnd,
					middleScale,
					extension,
				);
			}
			mesh.setVerticesData("position", nextPositions, true);
			this.refreshMeshBounds(mesh);
			return;
		}

		const skinDeltaByVertex = new Map<number, number>();
		components.forEach((component) => {
			if (bodyComponents.includes(component)) { return; }
			const mappedCenter = this.mapMotorBayAnchoredLengthX(
				component.center.x,
				middleStart,
				middleEnd,
				middleScale,
				extension,
			);
			const delta = mappedCenter - component.center.x;
			component.vertexIndices.forEach((vertexIndex) => {
				if (!bodyVertices.has(vertexIndex)) {
					skinDeltaByVertex.set(vertexIndex, delta);
				}
			});
		});

		for (let index = 0; index < nextPositions.length; index += 3) {
			const vertexIndex = index / 3;
			const x = positions[index];
			if (bodyVertices.has(vertexIndex)) {
				nextPositions[index] = this.mapMotorBayAnchoredLengthX(x, middleStart, middleEnd, middleScale, extension);
				continue;
			}
			const skinDelta = skinDeltaByVertex.get(vertexIndex);
			if (skinDelta !== undefined) {
				nextPositions[index] = x + skinDelta;
			} else {
				// 未归类顶点跟本体同样拉伸，避免悬空。
				nextPositions[index] = this.mapMotorBayAnchoredLengthX(x, middleStart, middleEnd, middleScale, extension);
			}
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * 根据支架显示参数切换前后支架节点。
	 */
	private applySupportVisibility(values: ValueMap): void {
		const showLegA = this.readBoolean(values, "showLegA", true) && this.readBoolean(values, "showFrontSupport", true);
		const showLegB = this.readBoolean(values, "showLegB", true) && this.readBoolean(values, "showRearSupport", true);
		const body = this.findNodeByName(BODY_NODE_NAME);
		let handledByMeshComponents = false;
		if (body) {
			this.getMeshesForNodes([body]).forEach((mesh) => {
				handledByMeshComponents = this.setMeshComponentsVisible(mesh, (component) => this.isLegAComponent(component), showLegA) || handledByMeshComponents;
				handledByMeshComponents = this.setMeshComponentsVisible(mesh, (component) => this.isLegBComponent(component), showLegB) || handledByMeshComponents;
			});
		}
		if (handledByMeshComponents) { return; }

		// 兼容未来拆分出腿部子节点的模型包。
		const legANodes = this.findNodes(/front|qian|前|zj01|leg.?a|support.?a|support.?front|front.?support/i);
		const legBNodes = this.findNodes(/rear|back|hou|后|zj02|leg.?b|support.?b|support.?rear|rear.?support/i);
		this.setNodesEnabled(legANodes, showLegA);
		this.setNodesEnabled(legBNodes, showLegB);
	}

	/**
	 * 电机位置：零件 = length 电机侧保护区；
	 * 0 时电机组 max.x 对齐腿 A 上方横梁的 max.x；增大则相对该基准偏移。
	 */
	private applyMotorParameters(values: ValueMap, _widthRatio: number): void {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return; }
		const motorPos = this.readNumber(values, "motorPosition", Number(DEFAULT_VALUES.motorPosition));
		const showMotor = this.readBoolean(values, "showMotor", true);
		const meshes = this.getMeshesForNodes([body]);
		const baselineBounds = this.getLocalVertexBounds(meshes, "x", false);
		const baselineBoundsZ = this.getLocalVertexBounds(meshes, "z", false);
		const sourceLength = baselineBounds ? baselineBounds.max - baselineBounds.min : 0;
		const sourceWidth = baselineBoundsZ ? baselineBoundsZ.max - baselineBoundsZ.min : 0;
		const motorBayEndX = baselineBounds && sourceLength > 0
			? this.getMotorBayProtectEndX(meshes, baselineBounds, sourceLength)
			: Number.NEGATIVE_INFINITY;
		const excludedCenters: Vector3[] = [];
		meshes.forEach((mesh) => {
			this.getMeshComponents(mesh).forEach((component) => {
				if (this.isExcludedMotorTopSideHardware(component)) {
					excludedCenters.push(component.center.clone());
				}
			});
		});
		const isMotorPositionPart = (component: MeshComponentSnapshot) => (
			this.isMotorPositionComponent(component, motorBayEndX, sourceLength, excludedCenters)
		);

		const upperBeams = this.collectUpperLegBeamComponents(meshes, sourceWidth);
		const beamMeter = this.getComponentsMeterXBounds(
			meshes,
			(component) => upperBeams.includes(component),
			true,
		);
		const assemblyMeter = this.getComponentsMeterXBounds(meshes, isMotorPositionPart, true);
		if (!beamMeter || !assemblyMeter || !meshes[0]) {
			meshes.forEach((mesh) => this.setMeshComponentsVisible(mesh, isMotorPositionPart, showMotor));
			return;
		}

		// 0 = 电机组 maximum.x 对齐腿 A 横梁 maximum.x；motorPos 增大则向 -X 移开。
		const targetMeterMax = beamMeter.max - motorPos;
		const meterDeltaX = targetMeterMax - assemblyMeter.max;
		const deltaX = this.entityMeterDeltaXToMeshLocalX(meshes[0], meterDeltaX);

		meshes.forEach((mesh) => {
			this.updateMeshComponents(mesh, isMotorPositionPart, new Vector3(deltaX, 0, 0), true);
			this.setMeshComponentsVisible(mesh, isMotorPositionPart, showMotor);
		});
	}

	/**
	 * 仅腿 A 的偏上横梁：非立柱、center.y 在立柱高度 45% 以上、偏水平/横跨。
	 */
	private collectUpperLegBeamComponents(meshes: any[], sourceWidth: number): MeshComponentSnapshot[] {
		const beams: MeshComponentSnapshot[] = [];
		meshes.forEach((mesh) => {
			const components = this.getMeshComponents(mesh);
			const legComponents = components.filter((component) => this.isLegAComponent(component));
			const pillars = this.pickLegPillarsToStretch(legComponents);
			if (legComponents.length === 0) { return; }
			let upperLegMinCenterY = 0.45;
			const pillarSet = new Set(pillars);
			if (pillars.length > 0) {
				const pillarBottom = Math.min(...pillars.map((pillar) => pillar.minimum.y));
				const pillarTop = Math.max(...pillars.map((pillar) => pillar.maximum.y));
				upperLegMinCenterY = pillarBottom + (pillarTop - pillarBottom) * 0.45;
			}
			legComponents.forEach((component) => {
				if (pillarSet.has(component)) { return; }
				if (component.center.y < upperLegMinCenterY) { return; }
				const looksColumn = component.size.y >= component.size.x
					&& component.size.y >= component.size.z
					&& component.size.y >= 0.08;
				if (looksColumn) { return; }
				const spansWidth = sourceWidth > 0 && component.size.z >= sourceWidth * 0.15;
				const flatBar = component.size.y <= Math.max(component.size.x, component.size.z) * 0.85;
				if (!spansWidth && !flatBar) { return; }
				beams.push(component);
			});
		});
		return beams;
	}

	/**
	 * 指定连通组件在实体根米空间中的当前/基线 X 范围。
	 */
	private getComponentsMeterXBounds(
		meshes: any[],
		predicate: (component: MeshComponentSnapshot) => boolean,
		current: boolean,
	): { min: number; max: number } | null {
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const inverseEntityRootWorldMatrix = entityRootWorldMatrix?.clone?.();
		if (!inverseEntityRootWorldMatrix?.invert) { return null; }
		inverseEntityRootWorldMatrix.invert();
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = current
				? this.readVertexPositions(mesh)
				: this.rememberSnapshot(mesh).vertexPositions;
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			this.getMeshComponents(mesh).forEach((component) => {
				if (!predicate(component)) { return; }
				component.vertexIndices.forEach((vertexIndex) => {
					const offset = vertexIndex * 3;
					const world = Vector3.TransformCoordinates(
						new Vector3(positions[offset], positions[offset + 1], positions[offset + 2]),
						worldMatrix,
					);
					const meter = Vector3.TransformCoordinates(world, inverseEntityRootWorldMatrix);
					min = Math.min(min, meter.x);
					max = Math.max(max, meter.x);
				});
			});
		});
		return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
	}

	/** 将实体根米空间 X 位移转为目标 mesh 局部 X 位移。 */
	private entityMeterDeltaXToMeshLocalX(mesh: any, meterDeltaX: number): number {
		if (Math.abs(meterDeltaX) < PARAMETER_EPSILON) { return 0; }
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const meshWorldMatrix = mesh?.computeWorldMatrix?.(true) ?? mesh?.getWorldMatrix?.();
		const inverseMeshWorldMatrix = meshWorldMatrix?.clone?.();
		if (!entityRootWorldMatrix || !inverseMeshWorldMatrix?.invert) { return meterDeltaX; }
		inverseMeshWorldMatrix.invert();
		const worldDelta = Vector3.TransformNormal(new Vector3(meterDeltaX, 0, 0), entityRootWorldMatrix);
		return Vector3.TransformNormal(worldDelta, inverseMeshWorldMatrix).x;
	}

	/**
	 * 使用参数色对 ZT.2 / Ban.4 材质做实例级着色，避免修改共享材质或原始 GLB。
	 */
	private applyBodyColor(values: ValueMap): void {
		const color = this.readColor3(values, "bodyColor", String(DEFAULT_VALUES.bodyColor));
		const targets = [this.findNodeByName(BODY_NODE_NAME), this.findNodeByName(PLATFORM_NODE_NAME)].filter(Boolean);
		targets.forEach((target) => {
			this.getMeshesForNodes([target]).forEach((mesh, index) => {
				const originalMaterial = this.rememberSnapshot(mesh).material ?? mesh.material;
				const material = originalMaterial?.clone?.(
					`${String(originalMaterial?.name ?? "YZJBodyMaterial")}_${String(target.name ?? "node")}_${index}`,
				);
				if (!material) { return; }
				if ("albedoColor" in material) { material.albedoColor = color.clone(); }
				if ("diffuseColor" in material) { material.diffuseColor = color.clone(); }
				if ("baseColor" in material) { material.baseColor = color.clone(); }
				mesh.material = material;
				this.generatedMaterials.push(material);
			});
		});
	}

	/**
	 * 「辊轮皮」开关：控制 GT.3 中除长圆柱辊轮体以外的剩余连通组件（轴头等）。
	 * 长圆柱辊轮体本身不受此开关影响。
	 */
	private applyRollerSkin(roller: any, visible: boolean): void {
		this.getMeshesForNodes([roller]).forEach((mesh) => {
			this.setMeshComponentsVisible(
				mesh,
				(component) => !this.isRollerBodyComponent(component),
				visible,
			);
		});
	}

	/**
	 * 写入入料/出料侧物流 metadata，供运行时和 Inspector 理解模型局部方向。
	 */
	private applyFlowDirection(values: ValueMap): void {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		if (!platform) { return; }
		const infeedSide = this.readTransferSide(values, "infeedSide", "left");
		const outfeedSide = this.readTransferSide(values, "outfeedSide", "front");
		const frontSide = this.readTransferSide(values, "frontSide", "right");
		const backSide = this.readTransferSide(values, "backSide", "left");
		const logisticsFlow = {
			infeedSide,
			outfeedSide,
			frontSide,
			backSide,
			coordinateSpace: "model-local",
			sideAxes: { left: "x+", right: "x-", front: "z-", rear: "z+" },
		};
		[this.node, platform, roller].filter(Boolean).forEach((target) => this.writeFlowMetadata(target, logisticsFlow));
	}

	/**
	 * 写入单个节点的物流方向 metadata，并保存旧值以便停止时恢复。
	 */
	private writeFlowMetadata(target: any, logisticsFlow: unknown): void {
		if (!target) { return; }
		if (!this.flowMetadataSnapshots.has(target)) {
			this.flowMetadataSnapshots.set(target, target.metadata?.logisticsFlow);
		}
		target.metadata = { ...(target.metadata ?? {}), logisticsFlow };
	}

	/**
	 * 恢复脚本写入前的 logisticsFlow metadata。
	 */
	private restoreFlowMetadata(): void {
		this.flowMetadataSnapshots.forEach((logisticsFlow, target) => {
			const metadata = { ...(target.metadata ?? {}) };
			if (logisticsFlow === undefined) { delete metadata.logisticsFlow; }
			else { metadata.logisticsFlow = logisticsFlow; }
			target.metadata = metadata;
		});
		this.flowMetadataSnapshots.clear();
	}

	/**
	 * 读取并校验入料/出料侧参数。
	 */
	private readTransferSide(values: ValueMap, key: string, fallback: TransferSide): TransferSide {
		const value = String(values[key] ?? "").toLowerCase();
		return value === "left" || value === "right" || value === "front" || value === "rear" ? value : fallback;
	}

	/**
	 * 刷新发光方向箭头；编辑态按出料侧显示，运行态按 runtimeTelemetry.movement_x 判定显示或隐藏。
	 */
	private updateDirectionArrowVisual(values: ValueMap): void {
		const targetSide = this.resolveDirectionArrowSide(values);
		if (!targetSide) {
			this.setDirectionArrowVisible(false);
			return;
		}
		const arrow = this.ensureDirectionArrow(values);
		if (!arrow) { return; }
		arrow.rotation = new Vector3(Math.PI / 2, this.getDirectionArrowYaw(targetSide), 0);
		this.setDirectionArrowVisible(true);
	}

	/**
	 * 创建或复用 Ban.4 顶面上的单个双面 Plane，贴图 URL 优先使用实例上已解析的 directionArrowImage 字符串。
	 */
	private ensureDirectionArrow(values: ValueMap): any | null {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		const scene = this.node.getScene?.();
		const textureUrl = this.readDirectionArrowTextureUrl(values);
		if (!platform || !scene || !textureUrl) {
			this.setDirectionArrowVisible(false);
			return null;
		}
		if (this.directionArrowFailedTextureUrl === textureUrl) {
			this.setDirectionArrowVisible(false);
			return null;
		}
		if (this.directionArrowMesh && this.directionArrowTextureUrl === textureUrl) {
			this.placeDirectionArrowOnPlatform(platform, this.directionArrowMesh);
			return this.directionArrowMesh;
		}
		this.disposeDirectionArrowResources();
		const bounds = this.getCurrentNodeBoundsInNodeLocal(platform);
		if (!bounds) { return null; }
		const shortSide = Math.min(bounds.maximum.x - bounds.minimum.x, bounds.maximum.z - bounds.minimum.z);
		const size = Math.max(0.01, shortSide * 0.56);
		const arrow = MeshBuilder.CreatePlane("YZJ_DirectionArrow_Glow", { size, sideOrientation: Mesh.DOUBLESIDE }, scene);
		arrow.parent = platform;
		arrow.isPickable = false;
		arrow.metadata = { generatedByParametricRuntime: true, directionArrowVisual: true };
		// 箭头固定在更高渲染组并最后绘制，避免透明平台或诊断材质覆盖发光效果。
		arrow.renderingGroupId = 2;
		arrow.alphaIndex = Number.MAX_SAFE_INTEGER;
		const material = new StandardMaterial("YZJ_DirectionArrow_Glow_Material", scene);
		material.backFaceCulling = false;
		material.diffuseColor = Color3.White();
		material.emissiveColor = Color3.White();
		material.alpha = 0.92;
		material.useAlphaFromDiffuseTexture = true;
		material.disableDepthWrite = true;
		material.depthFunction = Constants.ALWAYS;
		const texture = new Texture(textureUrl, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE, undefined, () => {
			this.directionArrowFailedTextureUrl = textureUrl;
			this.setDirectionArrowVisible(false);
			console.warn(`[YZJ] 方向箭头贴图加载失败: ${textureUrl}`);
		});
		material.diffuseTexture = texture;
		material.emissiveTexture = texture;
		material.opacityTexture = texture;
		arrow.material = material;
		this.directionArrowMesh = arrow;
		this.directionArrowMaterial = material;
		this.directionArrowTexture = texture;
		this.directionArrowTextureUrl = textureUrl;
		this.directionArrowFailedTextureUrl = "";
		this.placeDirectionArrowOnPlatform(platform, arrow);
		this.startDirectionArrowBreathing(scene);
		return arrow;
	}

	/**
	 * 将箭头放到 Ban.4 当前局部顶面中心，并按较短边约 1.2% 上浮以避免遮挡和深度闪烁。
	 */
	private placeDirectionArrowOnPlatform(platform: any, arrow: any): void {
		const bounds = this.getCurrentNodeBoundsInNodeLocal(platform);
		if (!bounds || !arrow.position) { return; }
		const shortSide = Math.min(bounds.maximum.x - bounds.minimum.x, bounds.maximum.z - bounds.minimum.z);
		arrow.position = new Vector3((bounds.minimum.x + bounds.maximum.x) / 2, bounds.maximum.y + Math.max(0.002, shortSide * 0.012), (bounds.minimum.z + bounds.maximum.z) / 2);
	}

	/**
	 * 启动透明度与缩放呼吸动画；重复创建前会先移除旧 observer。
	 */
	private startDirectionArrowBreathing(scene: any): void {
		if (this.directionArrowObserver) {
			scene.onBeforeRenderObservable?.remove?.(this.directionArrowObserver);
			this.directionArrowObserver = null;
		}
		this.directionArrowObserver = scene.onBeforeRenderObservable?.add?.(() => {
			if (!this.directionArrowMesh || !this.directionArrowMaterial) { return; }
			const timeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) % 1800;
			const wave = (Math.sin(timeMs / 1800 * Math.PI * 2) + 1) / 2;
			this.directionArrowMaterial.alpha = 0.55 + wave * 0.37;
			const scale = 1 + wave * 0.03;
			this.directionArrowMesh.scaling = new Vector3(scale, scale, scale);
		});
	}

	/**
	 * 根据编辑/运行模式解析箭头方向；运行态无数据、停止或故障时隐藏。
	 */
	private resolveDirectionArrowSide(values: ValueMap): TransferSide | null {
		if (!this.readBoolean(values, "showDirectionArrow", true)) { return null; }
		const outfeedSide = this.readTransferSide(values, "outfeedSide", "front");
		if (!this.isRuntimePreviewMode()) { return outfeedSide; }
		const telemetry = this.readRuntimeTelemetry();
		if (!telemetry || this.hasRuntimeFault(telemetry)) { return null; }
		const movement = this.readRuntimeMovementX(telemetry);
		if (movement === null || movement === 0) { return null; }
		if (movement === 2 || movement < 0) { return this.getOppositeTransferSide(outfeedSide); }
		return movement > 0 ? outfeedSide : null;
	}

	/**
	 * 判断当前是否为运行预览；runtimeMode 回到 edit 或未注入时恢复编辑态。
	 */
	private isRuntimePreviewMode(): boolean {
		const mode = String((this as unknown as ValueMap).runtimeMode ?? "edit").toLowerCase();
		return mode !== "" && mode !== "edit" && mode !== "editing" && mode !== "design";
	}

	/**
	 * 读取运行时代理直接注入实例属性的 telemetry，兼容 JSON 字符串。
	 */
	private readRuntimeTelemetry(): Record<string, unknown> | null {
		const source = (this as unknown as ValueMap).runtimeTelemetry;
		if (!source) { return null; }
		if (typeof source === "string") {
			try {
				const parsed = JSON.parse(source);
				return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
			} catch {
				return null;
			}
		}
		return typeof source === "object" ? source as Record<string, unknown> : null;
	}

	/**
	 * 读取运行方向字段；优先使用 ExternalModelScriptRuntime 注入的 fields.movement_x，不再把 rotation 当作方向。
	 */
	private readRuntimeMovementX(telemetry: Record<string, unknown>): number | null {
		const fields = this.readRuntimeTelemetryFields(telemetry);
		const raw = fields?.movement_x ?? fields?.movementX ?? telemetry.movement_x ?? telemetry.movementX;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	}

	/**
	 * 同时检查顶层和 fields 内的常见故障键，兼容顶层 faulted 合同。
	 */
	private hasRuntimeFault(telemetry: Record<string, unknown>): boolean {
		const keys = ["fault", "alarm", "error", "emergencyStop", "isFaulted", "faulted", "isEmergencyStop", "eStop"];
		const fields = this.readRuntimeTelemetryFields(telemetry);
		return keys.some((key) => this.isTruthyFaultValue(telemetry[key]) || this.isTruthyFaultValue(fields?.[key]));
	}

	/**
	 * 读取遥测 fields 对象，避免运行时外层状态与字段值混淆。
	 */
	private readRuntimeTelemetryFields(telemetry: Record<string, unknown>): Record<string, unknown> | null {
		const fields = telemetry.fields;
		return fields && typeof fields === "object" ? fields as Record<string, unknown> : null;
	}

	/**
	 * 将常见布尔、数值和字符串形式转换为故障真值。
	 */
	private isTruthyFaultValue(value: unknown): boolean {
		if (typeof value === "boolean") { return value; }
		if (typeof value === "number") { return value !== 0; }
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") { return false; }
			return true;
		}
		return false;
	}

	/**
	 * 读取方向箭头贴图 URL；实例属性优先，可接收运行时已解析后的真实 URL。
	 */
	private readDirectionArrowTextureUrl(values: ValueMap): string {
		const injected = (this as unknown as ValueMap).directionArrowImage;
		const value = injected !== undefined ? injected : values.directionArrowImage;
		return typeof value === "string" ? value.trim() : "";
	}

	/**
	 * 根据输送侧返回贴图 yaw；PNG 基准朝模型局部 X+。
	 */
	private getDirectionArrowYaw(side: TransferSide): number {
		if (side === "right") { return Math.PI; }
		if (side === "front") { return Math.PI / 2; }
		if (side === "rear") { return -Math.PI / 2; }
		return 0;
	}

	/**
	 * 返回出料侧的相反方向，用于 movement_x=2 或负值反向显示。
	 */
	private getOppositeTransferSide(side: TransferSide): TransferSide {
		if (side === "left") { return "right"; }
		if (side === "right") { return "left"; }
		if (side === "front") { return "rear"; }
		return "front";
	}

	/**
	 * 批量切换箭头 Mesh 可见性，加载失败或运行态停止时仅隐藏不抛错。
	 */
	private setDirectionArrowVisible(visible: boolean): void {
		if (!this.directionArrowMesh) { return; }
		this.directionArrowMesh.isVisible = visible;
		if (typeof this.directionArrowMesh.setEnabled === "function") { this.directionArrowMesh.setEnabled(visible); }
	}

	/**
	 * 完整释放方向箭头 observer、Mesh、Material、Texture，供参数刷新和生命周期结束调用。
	 */
	private disposeDirectionArrowResources(): void {
		const scene = this.node.getScene?.();
		if (this.directionArrowObserver) {
			scene?.onBeforeRenderObservable?.remove?.(this.directionArrowObserver);
			this.directionArrowObserver = null;
		}
		if (this.directionArrowMesh && typeof this.directionArrowMesh.dispose === "function") { this.directionArrowMesh.dispose(false, true); }
		else {
			if (this.directionArrowMaterial && typeof this.directionArrowMaterial.dispose === "function") { this.directionArrowMaterial.dispose(); }
			if (this.directionArrowTexture && typeof this.directionArrowTexture.dispose === "function") { this.directionArrowTexture.dispose(); }
		}
		this.directionArrowMesh = null;
		this.directionArrowMaterial = null;
		this.directionArrowTexture = null;
		this.directionArrowTextureUrl = "";
	}

	/**
	 * 读取节点当前几何在自身局部坐标系下的包围盒，用于在 Ban.4 顶面定位箭头。
	 */
	private getCurrentNodeBoundsInNodeLocal(node: any): { minimum: Vector3; maximum: Vector3 } | null {
		const nodeWorldMatrix = node?.computeWorldMatrix?.(true) ?? node?.getWorldMatrix?.();
		const inverseNodeWorldMatrix = nodeWorldMatrix?.clone?.();
		if (!inverseNodeWorldMatrix?.invert) { return null; }
		inverseNodeWorldMatrix.invert();
		let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		this.getMeshesForNodes([node]).forEach((mesh) => {
			if (mesh?.metadata?.directionArrowVisual === true) { return; }
			const positions = this.readVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const local = Vector3.TransformCoordinates(world, inverseNodeWorldMatrix);
				minimum = Vector3.Minimize(minimum, local);
				maximum = Vector3.Maximize(maximum, local);
			}
		});
		if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) { return null; }
		return { minimum, maximum };
	}

	/**
	 * 将节点按指定轴缩放，并让给定轴尽量保持中心不漂移。
	 */
	private scaleNodeKeepingCenter(target: any, xScale: number, yScale: number, zScale: number, centeredAxes: AxisName[]): void {
		const snapshot = this.rememberSnapshot(target);
		if (!target.scaling || !target.position) { return; }
		const centerBefore = this.getNodeCenterInParent(target);
		target.scaling = new Vector3(snapshot.scaling.x * xScale, snapshot.scaling.y * yScale, snapshot.scaling.z * zScale);
		if (!centerBefore) { return; }
		let nextPosition = snapshot.position.clone();
		if (centeredAxes.includes("x")) { nextPosition = this.withVectorAxis(nextPosition, "x", this.getVectorAxis(nextPosition, "x") + this.getVectorAxis(centerBefore, "x") * (1 - xScale)); }
		if (centeredAxes.includes("y")) { nextPosition = this.withVectorAxis(nextPosition, "y", this.getVectorAxis(nextPosition, "y") + this.getVectorAxis(centerBefore, "y") * (1 - yScale)); }
		if (centeredAxes.includes("z")) { nextPosition = this.withVectorAxis(nextPosition, "z", this.getVectorAxis(nextPosition, "z") + this.getVectorAxis(centerBefore, "z") * (1 - zScale)); }
		target.position = nextPosition;
		this.refreshNodeMeshes(target);
	}

	/**
	 * 按轴锚点缩放节点，支持 min/max/center 三种锚点。
	 */
	private scaleNodeWithAxisAnchors(target: any, xScale: number, yScale: number, zScale: number, anchors: Partial<Record<AxisName, "min" | "max" | "center">>): void {
		const snapshot = this.rememberSnapshot(target);
		if (!target.scaling || !target.position) { return; }
		const bounds = this.getNodeBoundsInParent(target);
		target.scaling = new Vector3(snapshot.scaling.x * xScale, snapshot.scaling.y * yScale, snapshot.scaling.z * zScale);
		if (!bounds) { return; }
		let nextPosition = snapshot.position.clone();
		const scaleByAxis: Record<AxisName, number> = { x: xScale, y: yScale, z: zScale };
		(["x", "y", "z"] as AxisName[]).forEach((axis) => {
			const anchorMode = anchors[axis];
			if (!anchorMode) { return; }
			const minValue = this.getVectorAxis(bounds.minimum, axis);
			const maxValue = this.getVectorAxis(bounds.maximum, axis);
			const anchorValue = anchorMode === "min" ? minValue : anchorMode === "max" ? maxValue : (minValue + maxValue) / 2;
			nextPosition = this.withVectorAxis(nextPosition, axis, this.getVectorAxis(nextPosition, axis) + anchorValue * (1 - scaleByAxis[axis]));
		});
		target.position = nextPosition;
		this.refreshNodeMeshes(target);
	}

	/**
	 * 将节点指定轴设置为基础位置加米制 offset。
	 */
	private offsetNodeAxis(node: any, axis: AxisName, offsetMeters: number): void {
		const snapshot = this.rememberSnapshot(node);
		if (!node.position) { return; }
		const meterOffset = this.withVectorAxis(Vector3.Zero(), axis, offsetMeters);
		node.position = snapshot.position.add(this.meterOffsetToParentLocal(node, meterOffset));
	}

	/**
	 * 在节点当前指定轴位置上累加米制 offset。
	 */
	private addNodeAxisOffset(node: any, axis: AxisName, offsetMeters: number): void {
		if (!node.position) { return; }
		const meterOffset = this.withVectorAxis(Vector3.Zero(), axis, offsetMeters);
		node.position = node.position.add(this.meterOffsetToParentLocal(node, meterOffset));
	}

	/**
	 * 克隆单根辊筒并写入运动继承 metadata；方向箭头不会使用该方法。
	 */
	/** 将实体根米空间位移转换为目标父节点本地位移，兼容厘米源模型与用户非均匀缩放。 */
	private meterOffsetToParentLocal(target: any, meterOffset: Vector3): Vector3 {
		const entityRoot = this.node.parent;
		const targetParent = target?.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const targetParentWorldMatrix = targetParent?.computeWorldMatrix?.(true) ?? targetParent?.getWorldMatrix?.();
		const inverseTargetParentWorldMatrix = targetParentWorldMatrix?.clone?.();
		if (!entityRootWorldMatrix || !inverseTargetParentWorldMatrix?.invert) { return meterOffset.clone?.() ?? meterOffset; }
		inverseTargetParentWorldMatrix.invert();
		const worldOffset = Vector3.TransformNormal(meterOffset, entityRootWorldMatrix);
		return Vector3.TransformNormal(worldOffset, inverseTargetParentWorldMatrix);
	}

	private cloneSingleNode(source: any, reason: string, index: number): any | null {
		if (typeof source.clone !== "function") { return null; }
		const clone = source.clone(`${String(source.name ?? "node")}_${reason}_${index}`, source.parent, false);
		if (!clone) { return null; }
		clone.metadata = {
			...(clone.metadata ?? {}),
			generatedByParametricRuntime: true,
			sourceNodeName: source.name,
			// Conveyor/MQTT 运行时据此让参数化克隆继承源节点的升降和旋转声明。
			motionSourceNodeName: source.name,
			reason,
		};
		if (typeof clone.setEnabled === "function") { clone.setEnabled(true); }
		this.generatedNodes.push(clone);
		return clone;
	}

	/**
	 * 释放参数化生成的辊筒克隆。
	 */
	private disposeGeneratedNodes(): void {
		while (this.generatedNodes.length > 0) {
			const generated = this.generatedNodes.pop();
			if (generated && typeof generated.dispose === "function") { generated.dispose(); }
		}
	}

	/**
	 * 返回当前模型根节点及所有子级 transform/mesh。
	 */
	private getModelNodes(): any[] {
		const scene = this.node.getScene?.();
		const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
		return [...new Set(nodes.filter((candidate) => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
	}

	/**
	 * 按精确名称查找子节点。
	 */
	private findNodeByName(name: string): any | null {
		return this.getModelNodes().find((candidate) => candidate !== this.node && String(candidate.name ?? "") === name) ?? null;
	}

	/**
	 * 按名称正则查找子节点。
	 */
	private findNodes(pattern: RegExp): any[] {
		return this.getModelNodes().filter((candidate) => candidate !== this.node && pattern.test(String(candidate.name ?? "")));
	}

	/**
	 * 收集节点自身和子级中的 mesh。
	 */
	private getMeshesForNodes(nodes: any[]): any[] {
		const meshes: any[] = [];
		nodes.forEach((node) => {
			if (this.isEditableMesh(node)) { meshes.push(node); }
			if (typeof node.getChildMeshes === "function") { meshes.push(...node.getChildMeshes(false).filter((child: any) => this.isEditableMesh(child))); }
		});
		return [...new Set(meshes)];
	}

	/**
	 * 读取一组 mesh 的原始局部顶点单轴范围。
	 */
	private getLocalVertexBounds(meshes: any[], axis: AxisName, current = false): { min: number; max: number } | null {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = current
				? this.readVertexPositions(mesh)
				: this.rememberSnapshot(mesh).vertexPositions;
			if (!positions) { return; }
			const axisOffset = axis === "x" ? 0 : axis === "y" ? 1 : 2;
			for (let index = axisOffset; index < positions.length; index += 3) {
				min = Math.min(min, positions[index]);
				max = Math.max(max, positions[index]);
			}
		});
		return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
	}

	/**
	 * 判断节点是否具备可读取 position 顶点数据。
	 */
	private isEditableMesh(node: any): boolean {
		const positions = node?.getVerticesData?.("position");
		return !node?.isDisposed?.()
			&& node?.isEnabled?.(false) !== false
			&& node?.isVisible !== false
			&& Number(node?.visibility ?? 1) > 0
			&& !!positions
			&& positions.length > 0;
	}

	/**
	 * 读取节点基线包围盒中心在父节点局部坐标系中的位置。
	 */
	/** 读取节点基线几何在实体根米空间中的包围盒。 */
	private getNodeMeterBounds(node: any): { minimum: Vector3; maximum: Vector3 } | null {
		return this.getNodeBoundsInMeterSpace(node, false);
	}

	/** 读取节点当前变形几何在实体根米空间中的包围盒。 */
	private getCurrentNodeMeterBounds(node: any): { minimum: Vector3; maximum: Vector3 } | null {
		return this.getNodeBoundsInMeterSpace(node, true);
	}

	/** 读取节点基线中心在实体根米空间指定轴上的坐标。 */
	private getNodeMeterCenterAxis(node: any, axis: AxisName): number | null {
		const bounds = this.getNodeMeterBounds(node);
		if (!bounds) { return null; }
		return (this.getVectorAxis(bounds.minimum, axis) + this.getVectorAxis(bounds.maximum, axis)) / 2;
	}

	/** 把节点顶点从世界坐标转换到实体根局部米空间后合并包围盒。 */
	private getNodeBoundsInMeterSpace(node: any, current: boolean): { minimum: Vector3; maximum: Vector3 } | null {
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const inverseEntityRootWorldMatrix = entityRootWorldMatrix?.clone?.();
		if (!inverseEntityRootWorldMatrix?.invert) { return null; }
		inverseEntityRootWorldMatrix.invert();
		let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		this.getMeshesForNodes([node]).forEach((mesh) => {
			const positions = current ? this.readVertexPositions(mesh) : this.rememberSnapshot(mesh).vertexPositions;
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const meterPoint = Vector3.TransformCoordinates(world, inverseEntityRootWorldMatrix);
				minimum = Vector3.Minimize(minimum, meterPoint);
				maximum = Vector3.Maximize(maximum, meterPoint);
			}
		});
		if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) { return null; }
		return { minimum, maximum };
	}

	private getNodeCenterInParent(node: any): Vector3 | null {
		const bounds = this.getNodeBoundsInParent(node);
		return bounds ? bounds.minimum.add(bounds.maximum).scale(0.5) : null;
	}

	/**
	 * 读取节点基线包围盒在父节点局部坐标系中的最小/最大点。
	 */
	private getNodeBoundsInParent(node: any): { minimum: Vector3; maximum: Vector3 } | null {
		const parent = node?.parent;
		const parentWorldMatrix = parent?.computeWorldMatrix?.(true) ?? parent?.getWorldMatrix?.();
		const inverseParentWorldMatrix = parentWorldMatrix?.clone?.();
		if (!inverseParentWorldMatrix?.invert) { return null; }
		inverseParentWorldMatrix.invert();
		let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		this.getMeshesForNodes([node]).forEach((mesh) => {
			const positions = this.rememberSnapshot(mesh).vertexPositions;
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const local = Vector3.TransformCoordinates(world, inverseParentWorldMatrix);
				minimum = Vector3.Minimize(minimum, local);
				maximum = Vector3.Maximize(maximum, local);
			}
		});
		if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) { return null; }
		return { minimum, maximum };
	}

	/**
	 * 读取节点当前变形后的包围盒，并换算到父节点局部坐标系，供位置约束使用。
	 */
	private getCurrentNodeBoundsInParent(node: any): { minimum: Vector3; maximum: Vector3 } | null {
		const parent = node?.parent;
		const parentWorldMatrix = parent?.computeWorldMatrix?.(true) ?? parent?.getWorldMatrix?.();
		const inverseParentWorldMatrix = parentWorldMatrix?.clone?.();
		if (!inverseParentWorldMatrix?.invert) { return null; }
		inverseParentWorldMatrix.invert();
		let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		this.getMeshesForNodes([node]).forEach((mesh) => {
			const positions = this.readVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const local = Vector3.TransformCoordinates(world, inverseParentWorldMatrix);
				minimum = Vector3.Minimize(minimum, local);
				maximum = Vector3.Maximize(maximum, local);
			}
		});
		if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) { return null; }
		return { minimum, maximum };
	}

	/**
	 * 读取节点基线中心在父节点局部单轴上的坐标。
	 */
	private getNodeCenterInParentAxis(node: any, axis: AxisName): number | null {
		const center = this.getNodeCenterInParent(node);
		return center ? this.getVectorAxis(center, axis) : null;
	}

	/**
	 * 批量设置节点启用状态。
	 */
	private setNodesEnabled(nodes: any[], enabled: boolean): void {
		nodes.forEach((node) => { if (typeof node.setEnabled === "function") { node.setEnabled(enabled); } });
	}

	/**
	 * 刷新节点下所有 mesh 的包围盒。
	 */
	private refreshNodeMeshes(node: any): void {
		this.getMeshesForNodes([node]).forEach((mesh) => this.refreshMeshBounds(mesh));
	}

	/**
	 * 刷新 mesh 包围盒，保证编辑器拾取和视图包围范围跟随顶点或缩放变化。
	 */
	private refreshMeshBounds(mesh: any): void {
		if (typeof mesh.refreshBoundingInfo === "function") { mesh.refreshBoundingInfo(true); }
		if (typeof mesh.computeWorldMatrix === "function") { mesh.computeWorldMatrix(true); }
	}

	/**
	 * 优先使用图片参数；图片参数保持默认而旧字段被显式修改时，继续执行旧场景语义。
	 */
	private resolveDimensionParameter(values: ValueMap, key: string, baseline: number, legacyKey: string, legacyBaseline: number): ResolvedDimension {
		const value = this.readPositiveNumber(values, key, baseline);
		const legacyValue = this.readPositiveNumber(values, legacyKey, legacyBaseline);
		const valueChanged = Math.abs(value - baseline) > PARAMETER_EPSILON;
		const legacyChanged = Math.abs(legacyValue - legacyBaseline) > PARAMETER_EPSILON;
		const usesLegacyValue = !valueChanged && legacyChanged;
		const resolvedValue = usesLegacyValue ? legacyValue : value;
		const resolvedBaseline = usesLegacyValue ? legacyBaseline : baseline;
		return {
			value: resolvedValue,
			baseline: resolvedBaseline,
			ratio: resolvedValue / resolvedBaseline,
			usesLegacyValue,
		};
	}

	/**
	 * 辊筒框架位置：距主体 length 拉伸后物流最左侧（x+）的米制距离；旧 platformPosition 仍作为附加偏移。
	 */
	private resolveRollerFrameOffset(values: ValueMap): number {
		const fromLeft = this.readNumber(values, "rollerFramePosition", Number(DEFAULT_VALUES.rollerFramePosition));
		const legacyOffset = this.readNumber(values, "platformPosition", 0);
		return fromLeft + legacyOffset;
	}

	/**
	 * 读取十六进制颜色参数，非法值回退到脚本默认色。
	 */
	private readColor3(values: ValueMap, key: string, fallback: string): Color3 {
		const candidate = typeof values[key] === "string" ? String(values[key]).trim() : fallback;
		const normalized = /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
		return Color3.FromHexString(normalized);
	}

	/**
	 * 读取并缓存单 Mesh 内按三角形连通性焊接后的组件，供腿、电机和辊轮皮参数化。
	 */
	private getMeshComponents(mesh: any): MeshComponentSnapshot[] {
		const cached = this.meshComponents.get(mesh);
		if (cached) { return cached; }
		const positions = this.rememberSnapshot(mesh).vertexPositions;
		const rawIndices = typeof mesh.getIndices === "function" ? mesh.getIndices() : null;
		if (!positions || !rawIndices || rawIndices.length < 3) {
			this.meshComponents.set(mesh, []);
			return [];
		}

		const indices = Array.from(rawIndices as ArrayLike<number>);
		const coordinateKeys: string[] = [];
		const vertexIndicesByKey = new Map<string, number[]>();
		for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex += 1) {
			const offset = vertexIndex * 3;
			const key = `${positions[offset].toFixed(5)},${positions[offset + 1].toFixed(5)},${positions[offset + 2].toFixed(5)}`;
			coordinateKeys[vertexIndex] = key;
			const existing = vertexIndicesByKey.get(key) ?? [];
			existing.push(vertexIndex);
			vertexIndicesByKey.set(key, existing);
		}

		const parents = new Map<string, string>();
		const findRoot = (key: string): string => {
			const parent = parents.get(key);
			if (!parent) { parents.set(key, key); return key; }
			if (parent === key) { return key; }
			const root = findRoot(parent);
			parents.set(key, root);
			return root;
		};
		const union = (left: string, right: string): void => {
			const leftRoot = findRoot(left);
			const rightRoot = findRoot(right);
			if (leftRoot !== rightRoot) { parents.set(rightRoot, leftRoot); }
		};

		for (let index = 0; index + 2 < indices.length; index += 3) {
			const first = coordinateKeys[indices[index]];
			const second = coordinateKeys[indices[index + 1]];
			const third = coordinateKeys[indices[index + 2]];
			if (!first || !second || !third) { continue; }
			union(first, second);
			union(second, third);
		}

		const verticesByRoot = new Map<string, Set<number>>();
		vertexIndicesByKey.forEach((vertexIndices, key) => {
			const root = findRoot(key);
			const target = verticesByRoot.get(root) ?? new Set<number>();
			vertexIndices.forEach((vertexIndex) => target.add(vertexIndex));
			verticesByRoot.set(root, target);
		});
		const facesByRoot = new Map<string, number>();
		for (let index = 0; index + 2 < indices.length; index += 3) {
			const key = coordinateKeys[indices[index]];
			if (!key) { continue; }
			const root = findRoot(key);
			facesByRoot.set(root, (facesByRoot.get(root) ?? 0) + 1);
		}

		const components = [...verticesByRoot.entries()].map(([root, vertexSet]) => {
			let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
			let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
			const vertexIndices = [...vertexSet];
			vertexIndices.forEach((vertexIndex) => {
				const offset = vertexIndex * 3;
				const point = new Vector3(positions[offset], positions[offset + 1], positions[offset + 2]);
				minimum = Vector3.Minimize(minimum, point);
				maximum = Vector3.Maximize(maximum, point);
			});
			return {
				vertexIndices,
				minimum,
				maximum,
				center: minimum.add(maximum).scale(0.5),
				size: maximum.subtract(minimum),
				faceCount: facesByRoot.get(root) ?? 0,
			};
		}).sort((left, right) => right.faceCount - left.faceCount);
		this.meshComponents.set(mesh, components);
		return components;
	}

	/**
	 * 对匹配的连通组件应用局部位移，并在关闭显示时把三角形收拢为退化面。
	 */
	private updateMeshComponents(mesh: any, predicate: (component: MeshComponentSnapshot) => boolean, translation: Vector3, visible: boolean): boolean {
		const components = this.getMeshComponents(mesh).filter(predicate);
		if (components.length === 0) { return false; }
		const positions = this.readVertexPositions(mesh);
		if (!positions || typeof mesh.setVerticesData !== "function") { return true; }
		let changed = false;
		components.forEach((component) => {
			if (Math.abs(translation.x) > PARAMETER_EPSILON || Math.abs(translation.y) > PARAMETER_EPSILON || Math.abs(translation.z) > PARAMETER_EPSILON) {
				component.vertexIndices.forEach((vertexIndex) => {
					const offset = vertexIndex * 3;
					positions[offset] += translation.x;
					positions[offset + 1] += translation.y;
					positions[offset + 2] += translation.z;
				});
				changed = true;
			}
			if (!visible) {
				let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
				let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
				component.vertexIndices.forEach((vertexIndex) => {
					const offset = vertexIndex * 3;
					const point = new Vector3(positions[offset], positions[offset + 1], positions[offset + 2]);
					minimum = Vector3.Minimize(minimum, point);
					maximum = Vector3.Maximize(maximum, point);
				});
				const center = minimum.add(maximum).scale(0.5);
				component.vertexIndices.forEach((vertexIndex) => {
					const offset = vertexIndex * 3;
					positions[offset] = center.x;
					positions[offset + 1] = center.y;
					positions[offset + 2] = center.z;
				});
				changed = true;
			}
		});
		if (changed) {
			mesh.setVerticesData("position", positions, true);
			this.refreshMeshBounds(mesh);
		}
		return true;
	}

	private setMeshComponentsVisible(mesh: any, predicate: (component: MeshComponentSnapshot) => boolean, visible: boolean): boolean {
		return this.updateMeshComponents(mesh, predicate, Vector3.Zero(), visible);
	}

	/** 腿 A 是 ZT.2 局部 X 负端、结构顶面以下的整组支撑组件。 */
	private isLegAComponent(component: MeshComponentSnapshot): boolean {
		return component.center.x < -1.2 && component.maximum.y <= 0.675;
	}

	/** 腿 B 是 ZT.2 局部 X 正端、结构顶面以下的整组支撑组件。 */
	private isLegBComponent(component: MeshComponentSnapshot): boolean {
		return component.center.x > -0.15 && component.maximum.y <= 0.675;
	}

	/**
	 * 电机位置联动件 = length 电机侧保护区；
	 * 排除腿、长向梁，以及台面顶侧小五金（拱形凸起、U 形带孔耳，含其同位置邻件）。
	 */
	private isMotorPositionComponent(
		component: MeshComponentSnapshot,
		motorBayEndX: number,
		sourceLength: number,
		excludedCenters: Vector3[] = [],
	): boolean {
		if (!Number.isFinite(motorBayEndX)) { return false; }
		if (this.isLegAComponent(component) || this.isLegBComponent(component)) { return false; }
		if (sourceLength > 0 && component.size.x >= sourceLength * 0.4) { return false; }
		if (this.isExcludedMotorTopSideHardware(component)) { return false; }
		if (this.isNearExcludedMotorHardware(component, excludedCenters)) { return false; }
		return component.center.x <= motorBayEndX;
	}

	/**
	 * 电机位置排除：台面顶侧小五金——拱形凸起、U 形带孔耳（图中多出、不随电机移动）。
	 */
	private isExcludedMotorTopSideHardware(component: MeshComponentSnapshot): boolean {
		if (this.isMotorComponent(component) || this.isMotorHousingComponent(component)) {
			return false;
		}
		const sx = component.size.x;
		const sy = component.size.y;
		const sz = component.size.z;
		const maxDim = Math.max(sx, sy, sz);
		const minDim = Math.min(sx, sy, sz);
		if (maxDim > 0.16 || maxDim < 0.012) { return false; }
		if (sx >= 0.18 || sz >= 0.22) { return false; }
		if (component.faceCount < 16 || component.faceCount > 500) { return false; }
		// 与顶拱同一高度带
		if (component.center.y < 0.48 || component.maximum.y < 0.55) { return false; }
		// 矮拱凸起
		const shortArch = sy <= 0.07 && minDim <= 0.05;
		// U 形带孔耳（可略高）
		const clevisEar = sy <= 0.16 && maxDim <= 0.14 && minDim <= 0.055;
		return shortArch || clevisEar;
	}

	/** 紧挨已排除顶侧五金的其它小件一并排除（「位置在一起」）。 */
	private isNearExcludedMotorHardware(component: MeshComponentSnapshot, excludedCenters: Vector3[]): boolean {
		if (excludedCenters.length === 0) { return false; }
		if (this.isMotorComponent(component) || this.isMotorHousingComponent(component)) {
			return false;
		}
		const maxDim = Math.max(component.size.x, component.size.y, component.size.z);
		if (maxDim > 0.2) { return false; }
		return excludedCenters.some((center) => Vector3.Distance(component.center, center) <= 0.18);
	}

	/** 电机由 ZT.2 中四个相邻、尺寸稳定的连通组件组成。 */
	private isMotorComponent(component: MeshComponentSnapshot): boolean {
		return component.center.x >= -0.68 && component.center.x <= -0.52
			&& component.center.y >= 0.42 && component.center.y <= 0.62
			&& component.minimum.z >= -0.12 && component.maximum.z <= 0.36
			&& component.size.x <= 0.15 && component.size.y <= 0.14 && component.size.z <= 0.3;
	}

	/** 台面下电机仓/盒：结构顶面以下、电机同侧中段、非腿非电机本体的邻近结构。 */
	private isMotorHousingComponent(component: MeshComponentSnapshot): boolean {
		if (this.isMotorComponent(component) || this.isLegAComponent(component) || this.isLegBComponent(component)) {
			return false;
		}
		if (component.center.y > 0.66 || component.maximum.y > 0.72) { return false; }
		if (component.minimum.x > -0.2 || component.maximum.x < -1.0) { return false; }
		if (component.maximum.z < -0.2 || component.minimum.z > 0.45) { return false; }
		return component.faceCount >= 40 || component.size.x >= 0.12 || component.size.z >= 0.12;
	}

	/** GT.3 中细长圆柱连通组件 = 辊轮本体（非「辊轮皮」开关目标）。 */
	private isRollerBodyComponent(component: MeshComponentSnapshot): boolean {
		return component.size.x > 0.5 && component.size.y < 0.12 && component.size.z < 0.12;
	}

	/** 取最长的细长件作为辊筒本体；短件（轴头/环）视为皮。 */
	private pickRollerBodyComponents(components: MeshComponentSnapshot[]): MeshComponentSnapshot[] {
		const candidates = components.filter((component) => this.isRollerBodyComponent(component));
		if (candidates.length > 0) { return candidates; }
		const maxSpanX = Math.max(0, ...components.map((component) => component.size.x));
		if (maxSpanX < 0.3) { return []; }
		return components.filter((component) => component.size.x >= maxSpanX * 0.85);
	}

	/** 释放主体颜色生成的实例材质，但保留原 GLB 共享纹理。 */
	private disposeGeneratedMaterials(): void {
		while (this.generatedMaterials.length > 0) {
			const material = this.generatedMaterials.pop();
			if (material && typeof material.dispose === "function") { material.dispose(false, false); }
		}
	}

	/**
	 * 读取字段相对默认值的倍率，参数单位为米。
	 */
	private ratio(values: ValueMap, key: string): number {
		const base = this.readPositiveNumber(DEFAULT_VALUES, key, 1);
		return this.readPositiveNumber(values, key, base) / base;
	}

	/**
	 * 读取数值字段，无法转换时使用默认值。
	 */
	private readNumber(values: ValueMap, key: string, fallback: number): number {
		const value = Number(values[key]);
		return Number.isFinite(value) ? value : fallback;
	}

	/**
	 * 读取正数数值字段，非正数或无效值使用默认值。
	 */
	private readPositiveNumber(values: ValueMap, key: string, fallback: number): number {
		const value = this.readNumber(values, key, fallback);
		return value > 0 ? value : fallback;
	}

	/**
	 * 读取布尔字段，兼容字符串形式的 true/false。
	 */
	private readBoolean(values: ValueMap, key: string, fallback: boolean): boolean {
		const value = values[key];
		if (typeof value === "boolean") { return value; }
		if (typeof value === "string") { return ["true", "1", "yes", "是", "启用"].includes(value.toLowerCase()); }
		return fallback;
	}

	/**
	 * 读取 Vector3 指定轴的值。
	 */
	private getVectorAxis(vector: Vector3, axis: AxisName): number {
		if (axis === "x") { return vector.x; }
		if (axis === "y") { return vector.y; }
		return vector.z;
	}

	/**
	 * 返回指定轴被替换后的 Vector3 副本。
	 */
	private withVectorAxis(vector: Vector3, axis: AxisName, value: number): Vector3 {
		if (axis === "x") { return new Vector3(value, vector.y, vector.z); }
		if (axis === "y") { return new Vector3(vector.x, value, vector.z); }
		return new Vector3(vector.x, vector.y, value);
	}

	/**
	 * 将数值限制在指定范围内。
	 */
	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}
}
