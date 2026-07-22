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

/**
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
	public rollerFramePosition: number = 0.1576491;

	@visibleAsNumber("辊筒框架长度", { step: 0.000001 })
	public rollerFrameLength: number = 1.021932;

	@visibleAsNumber("电机位置", { step: 0.0000001 })
	public motorPosition: number = 0.1814833;

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
	"rollerFramePosition": 0.1576491,
	"rollerFrameLength": 1.021932,
	"motorPosition": 0.1814833,
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
		const frameLength = this.resolveDimensionParameter(values, "rollerFrameLength", 1.021932, "platformLength", 1.022);
		const heightOffset = height.value - height.baseline;

		this.applyBodyParameters(length.ratio, width.ratio, height.ratio);
		const framePosition = this.resolvePlatformPosition(values, frameLength.ratio);
		this.applyPlatformParameters(frameLength.ratio, width.ratio, heightOffset, framePosition);
		this.applyRollerParameters(values, frameLength.ratio, heightOffset, framePosition, width.value);
		this.applyMotorParameters(values, width.ratio);
		this.applySupportVisibility(values);
		this.applyBodyColor(values);
		this.applyFlowDirection(values);
		this.updateDirectionArrowVisual(values);
	}

	/**
	 * 链条机主体 ZT.2 承担长、宽、高变化，底面保持在原始基准高度。
	 */
	private applyBodyParameters(lengthRatio: number, widthRatio: number, heightRatio: number): void {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return; }
		this.stretchBodyLength(body, lengthRatio);
		this.scaleNodeKeepingCenter(body, 1, heightRatio, widthRatio, ["z"]);
	}

	/**
	 * 主体长度采用端部保护的顶点分段拉伸：画面左侧保护段固定，右侧单向伸长。
	 */
	private stretchBodyLength(body: any, lengthRatio: number): void {
		if (Math.abs(lengthRatio - 1) < 0.0001) { return; }
		const meshes = this.getMeshesForNodes([body]);
		const bounds = this.getLocalVertexBounds(meshes, "x");
		if (!bounds) { return; }
		const sourceLength = bounds.max - bounds.min;
		if (sourceLength <= 0) { return; }
		const capLength = this.getProtectedBodyEndLength(sourceLength);
		const middleStart = bounds.min + capLength;
		const middleEnd = bounds.max - capLength;
		const middleLength = middleEnd - middleStart;
		if (middleLength <= 0) { return; }
		const requestedLength = sourceLength * lengthRatio;
		const targetLength = Math.max(requestedLength, capLength * 2 + Math.min(0.08, sourceLength * 0.08));
		const extension = targetLength - sourceLength;
		const middleScale = (middleLength + extension) / middleLength;
		meshes.forEach((mesh) => this.stretchMeshVerticesByLocalX(mesh, middleStart, middleEnd, middleScale, extension));
	}

	/**
	 * 根据当前 YZJ 主体网格的端部支腿分布计算保护段，避免长度变化时支腿厚度被拉伸。
	 */
	private getProtectedBodyEndLength(sourceLength: number): number {
		return Math.min(sourceLength * 0.22, Math.max(0.28, sourceLength * 0.18));
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
			nextPositions[index] = this.mapVisualLeftAnchoredLengthX(x, middleStart, middleEnd, middleScale, extension);
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * YZJ 导入朝向中，主体局部 X 最大端对应画面左侧；固定该端，长度差全部由另一端承担。
	 */
	private mapVisualLeftAnchoredLengthX(x: number, middleStart: number, middleEnd: number, middleScale: number, extension: number): number {
		if (x >= middleEnd) { return x; }
		if (x <= middleStart) { return x - extension; }
		return middleEnd + (x - middleEnd) * middleScale;
	}

	/**
	 * 将顶升组件米制偏移限制在当前主体有效长度内，避免平台移动到设备外部。
	 */
	private resolvePlatformPosition(values: ValueMap, platformLengthRatio: number): number {
		const requestedPosition = this.resolveRollerFrameOffset(values);
		const body = this.findNodeByName(BODY_NODE_NAME);
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (!body || !platform) { return requestedPosition; }
		const bodyBounds = this.getCurrentNodeMeterBounds(body);
		const platformBounds = this.getNodeMeterBounds(platform);
		if (!bodyBounds || !platformBounds) { return requestedPosition; }
		const platformCenter = (platformBounds.minimum.x + platformBounds.maximum.x) / 2;
		const platformHalfLength = (platformBounds.maximum.x - platformBounds.minimum.x) * platformLengthRatio / 2;
		const minimumPosition = bodyBounds.minimum.x + platformHalfLength - platformCenter;
		const maximumPosition = bodyBounds.maximum.x - platformHalfLength - platformCenter;
		if (minimumPosition > maximumPosition) { return 0; }
		return this.clamp(requestedPosition, Math.min(minimumPosition, 0), Math.max(maximumPosition, 0));
	}

	/**
	 * 顶升平台 Ban.4 使用独立 platformLength 控制长度，按中心缩放并随链条机宽度、高度和顶升位置同步变化。
	 */
	private applyPlatformParameters(platformLengthRatio: number, widthRatio: number, heightOffset: number, platformPosition: number): void {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (!platform) { return; }
		this.scaleNodeWithAxisAnchors(platform, platformLengthRatio, 1, widthRatio, { x: "center", z: "center" });
		this.offsetNodeAxis(platform, "y", heightOffset);
		this.addNodeAxisOffset(platform, "x", platformPosition);
	}

	/**
	 * 辊筒 GT.3 与 Ban.4 共用顶升模块长度和位置，按辊筒宽度调整单根厚度，并按密度生成多根。
	 */
	private applyRollerParameters(values: ValueMap, platformLengthRatio: number, heightOffset: number, platformPosition: number, targetWidth: number): void {
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		if (!roller) { return; }
		const rollerWidth = this.readPositiveNumber(values, "rollerWidth", Number(DEFAULT_VALUES.rollerWidth));
		const rollerWidthRatio = rollerWidth / Number(DEFAULT_VALUES.rollerWidth);
		const density = this.clamp(Math.max(1, Math.round(this.readNumber(values, "rollerDensity", 0.6))), 1, 80);
		const rollerPosition = this.readNumber(values, "rollerPosition", 0);
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		const platformBounds = platform ? this.getCurrentNodeMeterBounds(platform) : null;
		const distributionCenterZ = platformBounds ? (platformBounds.minimum.z + platformBounds.maximum.z) / 2 : 0;
		const centers = this.createRollerCenters(targetWidth, rollerWidth, density, distributionCenterZ);
		const baseCenterZ = this.getNodeMeterCenterAxis(roller, "z") ?? distributionCenterZ - targetWidth / 2 + rollerWidth / 2;
		this.scaleNodeWithAxisAnchors(roller, platformLengthRatio, 1, rollerWidthRatio, { x: "center", z: "center" });
		this.applyRollerSkin(roller, this.readBoolean(values, "rollerSkin", true));
		const rollerNodes = [roller];
		for (let index = 1; index < centers.length; index += 1) {
			const clone = this.cloneSingleNode(roller, "roller", index);
			if (!clone) { continue; }
			rollerNodes.push(clone);
		}
		rollerNodes.forEach((node, index) => this.placeRollerNode(node, platformPosition + rollerPosition, heightOffset, centers[index] ?? baseCenterZ, baseCenterZ));
	}

	/**
	 * 根据目标链条机宽度和辊筒厚度，围绕当前顶升平台米制中心生成辊筒中心线；密度为 1 时保持原模型单根辊筒语义。
	 */
	private createRollerCenters(chainWidth: number, rollerWidth: number, density: number, centerMeters: number): number[] {
		if (density <= 1) { return [this.getDefaultRollerCenterZ()]; }
		const usableWidth = Math.max(0, chainWidth - rollerWidth);
		const start = centerMeters - usableWidth / 2;
		const step = density > 1 ? usableWidth / (density - 1) : 0;
		return Array.from({ length: density }, (_, index) => start + step * index);
	}

	/**
	 * 读取默认单根辊筒的中心位置，无法读取时回退到模型默认宽度左侧的合理位置。
	 */
	private getDefaultRollerCenterZ(): number {
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		return roller ? (this.getNodeMeterCenterAxis(roller, "z") ?? -0.424) : -0.424;
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
	 * 在 ZT.2 单体网格中移动或隐藏电机组件；图片参数以当前 GLB 基线为绝对位置。
	 */
	private applyMotorParameters(values: ValueMap, widthRatio: number): void {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return; }
		const requestedPosition = this.readNumber(values, "motorPosition", Number(DEFAULT_VALUES.motorPosition));
		const positionOffset = requestedPosition - Number(DEFAULT_VALUES.motorPosition);
		const localOffset = positionOffset / Math.max(Math.abs(widthRatio), 0.0001);
		const showMotor = this.readBoolean(values, "showMotor", true);
		this.getMeshesForNodes([body]).forEach((mesh) => {
			this.updateMeshComponents(mesh, (component) => this.isMotorComponent(component), new Vector3(0, 0, localOffset), showMotor);
		});
	}

	/**
	 * 使用参数色对 ZT.2 材质做实例级着色，避免修改共享材质或原始 GLB。
	 */
	private applyBodyColor(values: ValueMap): void {
		const body = this.findNodeByName(BODY_NODE_NAME);
		if (!body) { return; }
		const color = this.readColor3(values, "bodyColor", String(DEFAULT_VALUES.bodyColor));
		this.getMeshesForNodes([body]).forEach((mesh, index) => {
			const originalMaterial = this.rememberSnapshot(mesh).material ?? mesh.material;
			const material = originalMaterial?.clone?.(`${String(originalMaterial?.name ?? "YZJBodyMaterial")}_parametric_${index}`);
			if (!material) { return; }
			if ("albedoColor" in material) { material.albedoColor = color.clone(); }
			if ("diffuseColor" in material) { material.diffuseColor = color.clone(); }
			if ("baseColor" in material) { material.baseColor = color.clone(); }
			mesh.material = material;
			this.generatedMaterials.push(material);
		});
	}

	/**
	 * 辊轮皮对应 GT.3 中的长圆柱连通组件，关闭时只保留两端轴头。
	 */
	private applyRollerSkin(roller: any, visible: boolean): void {
		this.getMeshesForNodes([roller]).forEach((mesh) => {
			this.setMeshComponentsVisible(mesh, (component) => this.isRollerSkinComponent(component), visible);
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
	private getLocalVertexBounds(meshes: any[], axis: AxisName): { min: number; max: number } | null {
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = this.rememberSnapshot(mesh).vertexPositions;
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
	 * 将图片中的绝对辊筒框架位置转换为当前 GLB 基线偏移；旧 platformPosition 仍按偏移解释。
	 */
	private resolveRollerFrameOffset(values: ValueMap): number {
		const baseline = Number(DEFAULT_VALUES.rollerFramePosition);
		const absolutePosition = this.readNumber(values, "rollerFramePosition", baseline);
		const legacyOffset = this.readNumber(values, "platformPosition", 0);
		if (Math.abs(absolutePosition - baseline) <= PARAMETER_EPSILON && Math.abs(legacyOffset) > PARAMETER_EPSILON) { return legacyOffset; }
		return absolutePosition - baseline;
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

	/** 电机由 ZT.2 中四个相邻、尺寸稳定的连通组件组成。 */
	private isMotorComponent(component: MeshComponentSnapshot): boolean {
		return component.center.x >= -0.68 && component.center.x <= -0.52
			&& component.center.y >= 0.42 && component.center.y <= 0.62
			&& component.minimum.z >= -0.12 && component.maximum.z <= 0.36
			&& component.size.x <= 0.15 && component.size.y <= 0.14 && component.size.z <= 0.3;
	}

	/** GT.3 最长的圆柱连通组件即图片参数中的辊轮皮。 */
	private isRollerSkinComponent(component: MeshComponentSnapshot): boolean {
		return component.size.x > 0.8 && component.size.y < 0.08 && component.size.z < 0.08;
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
