// 此文件由模型包参数脚本和运行脚本合并而成，供编辑器以单个 TS 文件读取。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { visibleAsBoolean, visibleAsNumber, visibleAsString } from "babylonjs-editor-tools";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

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

// 此文件按模型参数化说明生成，用于 一体式顶升移载 的静态参数配置。
// 静态参数只描述设备几何语义；运行时按 YZJ.glb 的 ZT.2 / GT.3 / Ban.4 三个真实子结构执行。

/**
 * 管理 一体式顶升移载 在 Babylon.js Editor Inspector 中展示的静态参数。
 */
export class ParametricModelParamsComponent {
	@visibleAsString("模型标识")
	public modelKey: string = "yzj";

	@visibleAsString("设备类型")
	public deviceType: string = "输送";

	@visibleAsString("设备名称")
	public deviceName: string = "一体式顶升移载";

	@visibleAsString("参数说明")
	public description: string = "支持链条机长宽高、顶升模块独立长度、辊筒宽度位置密度和前后支架显示隐藏参数化。";

	@visibleAsNumber("链条机长度", { step: 0.1 })
	public chainLength: number = 1.828;

	@visibleAsNumber("顶升模块长度", { step: 0.1 })
	public platformLength: number = 1.022;

	@visibleAsNumber("链条机宽度", { step: 0.1 })
	public chainWidth: number = 1.194;

	@visibleAsNumber("链条机高度", { step: 0.1 })
	public chainHeight: number = 0.803;

	@visibleAsNumber("辊筒宽度", { step: 0.01 })
	public rollerWidth: number = 0.062;

	@visibleAsNumber("辊筒位置", { step: 0.1 })
	public rollerPosition: number = 0;

	@visibleAsNumber("辊筒密度", { step: 1 })
	public rollerDensity: number = 1;

	@visibleAsBoolean("显示前支架")
	public showFrontSupport: boolean = true;

	@visibleAsBoolean("显示后支架")
	public showRearSupport: boolean = true;

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

interface NodeSnapshot {
	position: Vector3;
	scaling: Vector3;
	rotation?: Vector3;
	rotationQuaternion?: any;
	enabled?: boolean;
	vertexPositions?: number[];
}

const DEFAULT_VALUES: ValueMap = {
	"modelKey": "yzj",
	"deviceType": "输送",
	"deviceName": "一体式顶升移载",
	"description": "支持链条机长宽高、顶升模块独立长度、辊筒宽度位置密度和前后支架显示隐藏参数化。",
	"chainLength": 1.828,
	"platformLength": 1.022,
	"chainWidth": 1.194,
	"chainHeight": 0.803,
	"rollerWidth": 0.062,
	"rollerPosition": 0,
	"rollerDensity": 1,
	"showFrontSupport": true,
	"showRearSupport": true
};

const BODY_NODE_NAME = "ZT.2";
const ROLLER_NODE_NAME = "GT.3";
const PLATFORM_NODE_NAME = "Ban.4";

/**
 * 根据 Inspector 参数对 一体式顶升移载 执行静态参数化调整。
 */
export class ParametricModelRuntimeComponent {
	private readonly snapshots = new Map<any, NodeSnapshot>();
	private readonly generatedNodes: any[] = [];
	private readonly startupValues: ValueMap;
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
	 * 每帧检测参数签名变化，变化后恢复基线再重新应用。
	 */
	public onUpdate(): void {
		this.applyIfNeeded(false);
	}

	/**
	 * 停止脚本时清理生成节点，并恢复模型导入时的基础状态。
	 */
	public onStop(): void {
		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
		this.lastSignature = "";
	}

	/**
	 * 在参数变化或强制刷新时重新应用全部静态参数。
	 */
	private applyIfNeeded(force: boolean): void {
		const values = this.readParamValues();
		const signature = JSON.stringify(values);
		if (!force && signature === this.lastSignature) { return; }
		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
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
	 * 从模型 metadata 和启动缓存中读取 Inspector 参数。
	 */
	private readParamValues(): ValueMap {
		return { ...DEFAULT_VALUES, ...this.startupValues, ...this.readParamValuesFromMetadata() };
	}

	/**
	 * 从模型 metadata 中读取参数脚本保存的 values，metadata 缺失时返回空对象。
	 */
	private readParamValuesFromMetadata(): ValueMap {
		const scripts = Array.isArray(this.node.metadata?.scripts) ? this.node.metadata.scripts : [];
		for (const script of scripts) {
			const scriptName = String(script?.className ?? script?.name ?? script?.scriptFilename ?? "");
			const values = { ...this.readFieldDefaults(script), ...this.normalizeValueMap(script?.values), ...this.normalizeValueMap(script?.properties), ...this.normalizeValueMap(script?.config) };
			if (scriptName.includes("ParametricModelParamsComponent") || Object.keys(values).some((key) => key in DEFAULT_VALUES)) { return values; }
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
	 * 按 YZJ.glb 的真实结构应用参数，避免旧模板对整机根节点做二次缩放。
	 */
	private applyYZJParameters(values: ValueMap): void {
		const lengthRatio = this.ratio(values, "chainLength");
		const platformLengthRatio = this.ratio(values, "platformLength");
		const widthRatio = this.ratio(values, "chainWidth");
		const heightRatio = this.ratio(values, "chainHeight");
		const heightOffset = this.readPositiveNumber(values, "chainHeight", Number(DEFAULT_VALUES.chainHeight)) - Number(DEFAULT_VALUES.chainHeight);

		this.applyBodyParameters(lengthRatio, widthRatio, heightRatio);
		this.applyPlatformParameters(platformLengthRatio, widthRatio, heightOffset);
		this.applyRollerParameters(values, lengthRatio, heightOffset);
		this.applySupportVisibility(values);
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
	 * 主体长度采用端部保护的顶点分段拉伸：两端支腿和端头只平移，中间链条/侧梁承担长度变化。
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
		meshes.forEach((mesh) => this.stretchMeshVerticesByLocalX(mesh, middleStart, middleEnd, middleLength, middleScale, extension));
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
	private stretchMeshVerticesByLocalX(mesh: any, middleStart: number, middleEnd: number, middleLength: number, middleScale: number, extension: number): void {
		const positions = this.rememberSnapshot(mesh).vertexPositions;
		if (!positions || typeof mesh.setVerticesData !== "function") { return; }
		const nextPositions = positions.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			const x = positions[index];
			nextPositions[index] = this.mapVisualLeftAnchoredLengthX(x, middleStart, middleEnd, middleLength, middleScale, extension);
		}
		mesh.setVerticesData("position", nextPositions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * 视觉左端保持原位，中段线性伸缩，视觉右端整体延长。
	 * YZJ 的导入朝向中，屏幕左端对应主体局部 X 最大端，因此这里固定 middleEnd 侧。
	 */
	private mapVisualLeftAnchoredLengthX(x: number, middleStart: number, middleEnd: number, middleLength: number, middleScale: number, extension: number): number {
		if (x >= middleEnd) { return x; }
		if (x <= middleStart) { return x - extension; }
		return middleEnd - (middleEnd - x) / middleLength * middleLength * middleScale;
	}

	/**
	 * 顶升平台 Ban.4 使用独立 platformLength 控制红框内模块长度，并随链条机宽度和高度同步变化。
	 * 平台网格导入朝向与主体不同，视觉左侧对应平台局部 X 最小端。
	 */
	private applyPlatformParameters(platformLengthRatio: number, widthRatio: number, heightOffset: number): void {
		const platform = this.findNodeByName(PLATFORM_NODE_NAME);
		if (!platform) { return; }
		this.scaleNodeWithAxisAnchors(platform, platformLengthRatio, 1, widthRatio, { x: "min", z: "center" });
		this.offsetNodeAxis(platform, "y", heightOffset);
	}

	/**
	 * 辊筒 GT.3 按链条机长度伸缩，按辊筒宽度调整单根厚度，并按密度沿设备局部宽度方向生成多根。
	 * 辊筒模板的视觉左侧同样对应局部 X 最小端，避免主体左端固定时上部辊筒反向漂移。
	 */
	private applyRollerParameters(values: ValueMap, lengthRatio: number, heightOffset: number): void {
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		if (!roller) { return; }

		const rollerWidth = this.readPositiveNumber(values, "rollerWidth", Number(DEFAULT_VALUES.rollerWidth));
		const widthRatio = rollerWidth / Number(DEFAULT_VALUES.rollerWidth);
		const density = this.clamp(Math.round(this.readNumber(values, "rollerDensity", 1)), 1, 80);
		const rollerPosition = this.readNumber(values, "rollerPosition", 0);
		const targetWidth = this.readPositiveNumber(values, "chainWidth", Number(DEFAULT_VALUES.chainWidth));
		const centers = this.createRollerCenters(targetWidth, rollerWidth, density);
		const baseCenterZ = this.getNodeCenterInParentAxis(roller, "z") ?? -targetWidth / 2 + rollerWidth / 2;

		this.scaleNodeWithAxisAnchors(roller, lengthRatio, 1, widthRatio, { x: "min", z: "center" });
		const rollerNodes = [roller];
		for (let index = 1; index < centers.length; index += 1) {
			const clone = this.cloneSingleNode(roller, "roller", index);
			if (!clone) { continue; }
			rollerNodes.push(clone);
		}
		rollerNodes.forEach((node, index) => this.placeRollerNode(node, rollerPosition, heightOffset, centers[index] ?? baseCenterZ, baseCenterZ));
	}

	/**
	 * 根据目标链条机宽度和辊筒厚度生成辊筒中心线位置，密度为 1 时保持原模型单根辊筒语义。
	 */
	private createRollerCenters(chainWidth: number, rollerWidth: number, density: number): number[] {
		if (density <= 1) { return [this.getDefaultRollerCenterZ()]; }
		const usableWidth = Math.max(0, chainWidth - rollerWidth);
		const start = -usableWidth / 2;
		const step = density > 1 ? usableWidth / (density - 1) : 0;
		return Array.from({ length: density }, (_, index) => start + step * index);
	}

	/**
	 * 读取默认单根辊筒的中心位置，无法读取时回退到模型默认宽度左侧的合理位置。
	 */
	private getDefaultRollerCenterZ(): number {
		const roller = this.findNodeByName(ROLLER_NODE_NAME);
		return roller ? (this.getNodeCenterInParentAxis(roller, "z") ?? -0.424) : -0.424;
	}

	/**
	 * 将辊筒放到目标局部位置；辊筒位置沿设备长度方向，密度分布沿设备宽度方向。
	 */
	private placeRollerNode(node: any, xOffset: number, yOffset: number, targetCenterZ: number, baseCenterZ: number): void {
		if (!node.position) { return; }
		let nextPosition = node.position.clone();
		nextPosition = this.withVectorAxis(nextPosition, "x", this.getVectorAxis(nextPosition, "x") + xOffset);
		nextPosition = this.withVectorAxis(nextPosition, "y", this.getVectorAxis(nextPosition, "y") + yOffset);
		nextPosition = this.withVectorAxis(nextPosition, "z", this.getVectorAxis(nextPosition, "z") + targetCenterZ - baseCenterZ);
		node.position = nextPosition;
	}

	/**
	 * 前后支架显示仅作用于明确命名的支架节点；当前 YZJ.glb 支架并入 ZT.2 时保持主体可见，避免误隐藏整机。
	 */
	private applySupportVisibility(values: ValueMap): void {
		const frontSupportNodes = this.findNodes(/front|qian|前|zj01|support.?front|front.?support/i);
		const rearSupportNodes = this.findNodes(/rear|back|hou|后|zj02|support.?rear|rear.?support/i);
		if (frontSupportNodes.length > 0 && "showFrontSupport" in values) {
			this.setNodesEnabled(frontSupportNodes, this.readBoolean(values, "showFrontSupport", true));
		}
		if (rearSupportNodes.length > 0 && "showRearSupport" in values) {
			this.setNodesEnabled(rearSupportNodes, this.readBoolean(values, "showRearSupport", true));
		}
	}

	/**
	 * 对节点应用缩放，并对指定轴做中心补偿，防止长宽变化时模型整体漂移。
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
	 * 对节点应用缩放，并允许指定单轴锚点；长度用最小端锚定，宽度继续按中心补偿。
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
	 * 按节点基础位置沿单个局部轴偏移，兼容父级旋转后的设备局部方向。
	 */
	private offsetNodeAxis(node: any, axis: AxisName, offset: number): void {
		const snapshot = this.rememberSnapshot(node);
		if (!node.position) { return; }
		node.position = this.withVectorAxis(node.position.clone(), axis, this.getVectorAxis(snapshot.position, axis) + offset);
	}

	/**
	 * 克隆单个节点并记录为运行时生成节点。
	 */
	private cloneSingleNode(source: any, reason: string, index: number): any | null {
		if (typeof source.clone !== "function") { return null; }
		const clone = source.clone(`${String(source.name ?? "node")}_${reason}_${index}`, source.parent, false);
		if (!clone) { return null; }
		clone.metadata = { ...(clone.metadata ?? {}), generatedByParametricRuntime: true, sourceNodeName: source.name, reason };
		if (typeof clone.setEnabled === "function") { clone.setEnabled(true); }
		this.generatedNodes.push(clone);
		return clone;
	}

	/**
	 * 清理本脚本生成的所有克隆节点。
	 */
	private disposeGeneratedNodes(): void {
		while (this.generatedNodes.length > 0) {
			const generated = this.generatedNodes.pop();
			if (generated && typeof generated.dispose === "function") { generated.dispose(); }
		}
	}

	/**
	 * 获取当前模型根节点及其子树内的节点。
	 */
	private getModelNodes(): any[] {
		const scene = this.node.getScene?.();
		const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
		return [...new Set(nodes.filter((candidate) => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
	}

	/**
	 * 按精确节点名查找模型子树内的节点。
	 */
	private findNodeByName(name: string): any | null {
		return this.getModelNodes().find((candidate) => candidate !== this.node && String(candidate.name ?? "") === name) ?? null;
	}

	/**
	 * 按名称正则查找模型子树内的节点。
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
	 * 读取一组 mesh 的原始本地顶点包围范围，用于长度分段拉伸的基线快照。
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
		return typeof node?.getVerticesData === "function" && !!node.getVerticesData("position");
	}

	/**
	 * 读取节点基线包围盒中心在父节点局部坐标系中的位置。
	 */
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
