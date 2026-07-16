// 此文件由模型包参数脚本和运行脚本合并而成，供编辑器以单个 TS 文件读取。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { visibleAsBoolean, visibleAsNumber, visibleAsString } from "babylonjs-editor-tools";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// 参数长度统一使用米；contentRoot 的基础 scaling 已由编辑器包含源单位换算。

// 此文件按模型参数化说明生成，用于 叉式堆垛机 的静态参数配置。
// 静态参数和数据驱动运动语义由模型包声明，场景级连接仍由编辑器属性面板配置。

/**
 * 声明 Stacker 的数据驱动运动语义，编辑器导入时会静态解析该对象而不会执行脚本。
 */
export const dataDriven = {
	device: {
		devType: "stacker",
		defaultAssetCode: "Stacker01",
		deviceIdField: "e",
		assetCodeField: "assetCode",
		interpolationMs: 200
	},
	motion: {
		travel: {
			fields: ["movement_x"],
			kind: "translate",
			axis: "z",
			valueMode: "action",
			actionMap: {"0": 0, "1": 1, "2": -1},
			speed: 0.8,
			// 默认原位沿模型局部 Z 轴回贴左端缓冲头，单位为米。
			initialOffset: -0.562846,
			nodes: [
				"dingbuhuagui2.3",
				"dingbuhuagui1.4",
				"dingbu.5",
				"dibu.6",
				"lizhu1.11",
				"lizhu2.12",
				"dianji.7",
				"caozuotai.8",
				"xiang.13",
				"huocha.9",
				"huocha2.10"
			],
			fallbackPattern: "dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha|顶部|底部|立柱|电机|操作台|载货|货叉"
		},
		lift: {
			fields: ["movement_y"],
			kind: "translate",
			axis: "y",
			valueMode: "action",
			actionMap: {"0": 0, "1": 1, "2": -1},
			speed: 0.3,
			nodes: ["xiang.13", "huocha.9", "huocha2.10"],
			fallbackPattern: "platform|cargo|bay|xiang|台|仓|fork|叉|huocha|cha\d*",
			limits: { min: 0, max: 2.6 }
		},
		fork: {
			fields: ["front_movement_z", "back_movement_z", "forkState"],
			kind: "translate",
			axis: "x",
			valueMode: "action",
			actionMap: {"0": 0, "1": 1, "2": -1, "3": 1, "4": -1},
			speed: 0.25,
			nodes: ["huocha.9", "huocha2.10"],
			stageTwoNodes: ["huocha.9_stage2", "huocha2.10_stage2"],
			fallbackPattern: "fork|叉|huocha|cha\d*",
			stageOneReach: 0.8,
			stageTwoReach: 0.8,
			limits: { min: 0, max: 1.6 }
		}
	},
	fixedNodes: ["guidaoshang.1", "guidaoxia.2"],
	simulation: {
		intervalMs: 250,
		travelRange: 2.8,
		liftBase: 0.35,
		liftRange: 2.1,
		forkRange: 1.6,
		forkStageOneReach: 0.8,
		forkStageTwoReach: 0.8,
		forkSideRange: 0.18
	}
} as const;


/**
 * 管理 叉式堆垛机 在 Babylon.js Editor Inspector 中展示的静态参数。
 */
export class ParametricModelParamsComponent {
	@visibleAsString("模型标识")
	public modelKey: string = "stacker";

	@visibleAsString("设备类型")
	public deviceType: string = "堆垛机";

	@visibleAsString("设备名称")
	public deviceName: string = "叉式堆垛机";

	@visibleAsString("参数说明")
	public description: string = "支持堆垛机主体尺寸、载货台尺寸、货叉长度和货叉间距参数化。";

	@visibleAsNumber("主体长度 (m)", { step: 0.1 })
	public bodyLength: number = 23.012;

	@visibleAsNumber("主体宽度 (m)", { step: 0.1 })
	public bodyWidth: number = 0.452;

	@visibleAsNumber("主体高度 (m)", { step: 0.1 })
	public bodyHeight: number = 7.837;

	@visibleAsNumber("载货台长度 (m)", { step: 0.1 })
	public platformLength: number = 1.279;

	@visibleAsNumber("载货台高度 (m)", { step: 0.1 })
	public platformHeight: number = 1.695;

	@visibleAsNumber("货叉长度 (m)", { step: 0.1 })
	public forkLength: number = 0.941;

	@visibleAsNumber("货叉第一段行程 (m)", { step: 0.05 })
	public forkStageOneReach: number = 0.8;

	@visibleAsNumber("货叉第二段行程 (m)", { step: 0.05 })
	public forkStageTwoReach: number = 0.8;

	@visibleAsNumber("货叉间距 (m)", { step: 0.05 })
	public forkGap: number = 0.6;

	/**
	 * 创建 叉式堆垛机 参数配置组件。
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

// 此文件按模型参数化说明生成，用于 叉式堆垛机 的静态参数化运行。
// 运行脚本只处理尺寸、阵列、显示隐藏、角度和基础布局，不包含旧动画或 外部数据驱动。


type ValueMap = Record<string, unknown>;
type ParametricAxisName = "x" | "y" | "z";

interface NodeSnapshot {
        position: Vector3;
        scaling: Vector3;
        rotation?: Vector3;
        rotationQuaternion?: any;
        enabled?: boolean;
        vertexPositions?: number[];
}

interface ForkVisualAnchor {
        node: any;
        bottom: number;
        center: Vector3;
}

const DEFAULT_VALUES: ValueMap = {
	"modelKey": "stacker",
	"deviceType": "堆垛机",
	"deviceName": "叉式堆垛机",
	"description": "支持堆垛机主体尺寸、载货台尺寸、货叉长度和货叉间距参数化。",
	"bodyLength": 23.012,
	"bodyWidth": 0.452,
	"bodyHeight": 7.837,
	"platformLength": 1.279,
	"platformHeight": 1.695,
	"forkLength": 0.941,
	"forkStageOneReach": 0.8,
	"forkStageTwoReach": 0.8,
	"forkGap": 0.6
};

/**
 * 根据 Inspector 参数对 叉式堆垛机 执行静态参数化调整。
 */
export class ParametricModelRuntimeComponent {
	private readonly snapshots = new Map<any, NodeSnapshot>();
	private readonly generatedNodes: any[] = [];
	private readonly startupValues: ValueMap;
	private lastSignature = "";

	/**
	 * 创建 叉式堆垛机 静态参数化运行组件。
	 * @param node 当前脚本绑定的模型根节点。
	 */
	public constructor(public node: TransformNode) {
		// Play/导出运行时会在 onStart 前清理 metadata.scripts，因此这里先缓存导入时的参数值。
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
		this.applyDimensionScale(values);
		this.applySupportVisibility(values);
		this.applyModelVisibility(values);
		this.applyPositionOffsets(values);
		this.applyAngleParameters(values);
		this.applyForkParameters(values);
		this.applyPlatformParameters(values);
		this.applyRollerDensity(values);
		this.applyCountArray(values);
		this.applyShelfArray(values);
		this.applyDoubleDeep(values);
		this.applyRouteParameters(values);
		this.applyStackerInitialTravelDocking();
		this.lastSignature = signature;
	}

	/**
	 * 将 Stacker 行走机构的默认原位回贴到下轨左端缓冲头，消除导入后的初始空隙。
	 */
	private applyStackerInitialTravelDocking(): void {
		const initialOffset = Number(dataDriven.motion.travel.initialOffset ?? 0);
		if (!Number.isFinite(initialOffset) || Math.abs(initialOffset) < 0.000001) { return; }
		const worldOffset = this.getParametricMeterAxis("z").scale(initialOffset);
		this.findStackerTravelNodes().forEach((node) => this.translateNodeByCurrentMeterDelta(node, worldOffset));
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
	 * 读取 mesh 的原始顶点坐标，用于长度拉伸前恢复基线。
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
	 * 从模型 metadata 中读取参数脚本保存的 values，缺失时使用本脚本内置默认值。
	 */
	private readParamValues(): ValueMap {
		return { ...DEFAULT_VALUES, ...this.startupValues, ...this.readParamValuesFromMetadata() };
	}

	/**
	 * 从模型 metadata 中读取参数脚本保存的 values，metadata 被运行时清理时返回空对象。
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
	 * 按 Stacker 的实际坐标系应用主体长宽高，只处理主体结构节点。
	 * GLB 的长度主方向是米空间 Z 轴，宽度主方向是米空间 X 轴；载货台和货叉字段由各自方法单独处理，避免整机二次缩放变形。
	 */
	private applyDimensionScale(values: ValueMap): void {
		const bodyWidthNodes = this.findStackerBodyWidthNodes();
		const xScale = this.ratioForNodesByMeterAxis(bodyWidthNodes, values, "bodyWidth", "x");
		this.applyAnchoredBodyLength(values);
		this.scaleNodesByMeterAxes(bodyWidthNodes, xScale, 1, 1);
		this.applyStackerBodyHeight(values);
	}

	/**
	 * 应用主体高度联动：底部保持原位，立柱向上延展，顶部横杆整体上移但不缩放。
	 */
	private applyStackerBodyHeight(values: ValueMap): void {
		if (!("bodyHeight" in values)) { return; }
		const mastMeshes = this.getMeshesForNodes(this.findStackerMastStretchNodes());
		const heightAxis = this.getParametricMeterAxis("y");
		const mastBounds = this.getMeterProjectedBounds(mastMeshes, heightAxis);
		if (!mastBounds) { return; }
		const mastHeight = mastBounds.max - mastBounds.min;
		if (mastHeight <= 0) { return; }
		const targetHeight = this.readPositiveNumber(values, "bodyHeight", mastHeight);
		const heightScale = targetHeight / mastHeight;
		if (Math.abs(heightScale - 1) < 0.0001) { return; }
		const clampedScale = Math.max(1 / mastHeight, heightScale);
		const extension = mastHeight * (clampedScale - 1);
		this.stretchMeshesFromAxisMin(mastMeshes, heightAxis, clampedScale);
		this.offsetNodesByMeterDelta(this.findStackerTopLiftNodes(), heightAxis.scale(extension));
	}

	/**
	 * 以模型左侧为锚点拉伸长轨，左端保护区不动，右端保护区整体平移，中间段承担长度变化。
	 */
	private applyAnchoredBodyLength(values: ValueMap): void {
		if (!("bodyLength" in values)) { return; }
		const railMeshes = this.getMeshesForNodes(this.findStackerLengthNodes());
		const lengthScale = this.ratioForMeshesByMeterAxis(railMeshes, values, "bodyLength", "z");
		this.stretchMeshesByMeterZ(railMeshes, lengthScale);
	}

	/**
	 * 按米空间 Z 轴分段拉伸 mesh，保护两端端部结构不被缩放。
	 */
	private stretchMeshesByMeterZ(meshes: any[], lengthScale: number): void {
		if (meshes.length === 0 || Math.abs(lengthScale - 1) < 0.0001) { return; }
		const lengthAxis = this.getParametricMeterAxis("z");
		const bounds = this.getMeterProjectedBounds(meshes, lengthAxis);
		if (!bounds) { return; }
		const sourceLength = bounds.max - bounds.min;
		if (sourceLength <= 0) { return; }
		const capLength = this.getProtectedEndLength(sourceLength);
		const minScale = (2 * capLength + 1) / sourceLength;
		const clampedScale = Math.max(lengthScale, minScale);
		const targetLength = sourceLength * clampedScale;
		const extension = targetLength - sourceLength;
		const sourceMiddleStart = bounds.min + capLength;
		const sourceMiddleEnd = bounds.max - capLength;
		const sourceMiddleLength = Math.max(1, sourceMiddleEnd - sourceMiddleStart);
		const targetMiddleLength = Math.max(1, targetLength - 2 * capLength);
		const middleScale = targetMiddleLength / sourceMiddleLength;
		meshes.forEach((mesh) => this.stretchMeshByProjectedAxis(mesh, lengthAxis, sourceMiddleStart, sourceMiddleEnd, sourceMiddleLength, middleScale, extension));
	}

	/**
	 * 计算长度端部保护区大小，避免红框端头随长度参数变形。
	 */
	private getProtectedEndLength(sourceLength: number): number {
		return Math.min(sourceLength * 0.2, Math.max(0.4, sourceLength * 0.04));
	}

	/**
	 * 拉伸单个 mesh：左端保护区保持原位，右端保护区整体右移，中间段线性延展。
	 */
	private stretchMeshByProjectedAxis(mesh: any, axis: Vector3, sourceMiddleStart: number, sourceMiddleEnd: number, sourceMiddleLength: number, middleScale: number, extension: number): void {
		const positions = this.getBaseVertexPositions(mesh);
		const worldMatrix = mesh.computeWorldMatrix?.(true);
		const inverseWorldMatrix = worldMatrix?.clone?.();
		const meterSpace = this.getMeterSpaceMatrices();
		if (!positions || !worldMatrix || !inverseWorldMatrix?.invert || !meterSpace) { return; }
		inverseWorldMatrix.invert();
		const nextPositions = positions.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			const local = new Vector3(positions[index], positions[index + 1], positions[index + 2]);
			const world = Vector3.TransformCoordinates(local, worldMatrix);
			const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
			const sourceAxisValue = this.projectMeterPoint(meterPoint, axis);
			const nextAxisValue = this.mapAnchoredAxisValue(sourceAxisValue, sourceMiddleStart, sourceMiddleEnd, sourceMiddleLength, middleScale, extension);
			if (Math.abs(nextAxisValue - sourceAxisValue) < 0.0001) { continue; }
			const nextMeterPoint = meterPoint.add(axis.scale(nextAxisValue - sourceAxisValue));
			const nextWorld = Vector3.TransformCoordinates(nextMeterPoint, meterSpace.entityRootWorldMatrix);
			const nextLocal = Vector3.TransformCoordinates(nextWorld, inverseWorldMatrix);
			nextPositions[index] = nextLocal.x;
			nextPositions[index + 1] = nextLocal.y;
			nextPositions[index + 2] = nextLocal.z;
		}
		this.writeVertexPositions(mesh, nextPositions);
	}

	/**
	 * 根据顶点原始米空间 Z 坐标计算锚定拉伸后的米空间 Z 坐标。
	 */
	private mapAnchoredAxisValue(axisValue: number, sourceMiddleStart: number, sourceMiddleEnd: number, sourceMiddleLength: number, middleScale: number, extension: number): number {
		if (axisValue <= sourceMiddleStart) { return axisValue; }
		if (axisValue >= sourceMiddleEnd) { return axisValue + extension; }
		return sourceMiddleStart + (axisValue - sourceMiddleStart) / sourceMiddleLength * sourceMiddleLength * middleScale;
	}

	/**
	 * 优先使用启动时快照中的原始顶点，避免多次参数变化后累积误差。
	 */
	private getBaseVertexPositions(mesh: any): number[] | undefined {
		return this.rememberSnapshot(mesh).vertexPositions;
	}

	/**
	 * 写回 mesh 顶点坐标并刷新包围盒。
	 */
	private writeVertexPositions(mesh: any, positions: number[]): void {
		if (typeof mesh.setVerticesData !== "function") { return; }
		mesh.setVerticesData("position", positions, true);
		this.refreshMeshBounds(mesh);
	}

	/**
	 * 刷新 mesh 包围盒，保证编辑器拾取和视图包围范围跟随顶点变化。
	 */
	private refreshMeshBounds(mesh: any): void {
		if (typeof mesh.refreshBoundingInfo === "function") { mesh.refreshBoundingInfo(true); }
		if (typeof mesh.computeWorldMatrix === "function") { mesh.computeWorldMatrix(true); }
	}

	/**
	 * 计算一组 mesh 的米空间 Z 包围范围。
	 */
	/**
	 * 对指定节点应用相对基础缩放。
	 */
	private scaleNode(target: any, xScale: number, yScale: number, zScale: number): void {
		const snapshot = this.rememberSnapshot(target);
		if (!target.scaling) { return; }
		target.scaling = new Vector3(snapshot.scaling.x * xScale, snapshot.scaling.y * yScale, snapshot.scaling.z * zScale);
	}

	/**
	 * 对一组节点按实体根米空间轴应用缩放，避免 GLB 节点局部旋转导致长宽高语义反向。
	 */
	private scaleNodesByMeterAxes(nodes: any[], worldXScale: number, worldYScale: number, worldZScale: number): void {
		nodes.forEach((node) => this.scaleNodeByMeterAxes(node, worldXScale, worldYScale, worldZScale));
	}

	/**
	 * 将实体根米空间轴倍率转换成目标节点的局部缩放倍率。
	 */
	private scaleNodeByMeterAxes(target: any, worldXScale: number, worldYScale: number, worldZScale: number): void {
		const snapshot = this.rememberSnapshot(target);
		if (!target.scaling) { return; }
		const localScale = this.getLocalScaleForParametricAxes(target, worldXScale, worldYScale, worldZScale);
		target.scaling = new Vector3(snapshot.scaling.x * localScale.x, snapshot.scaling.y * localScale.y, snapshot.scaling.z * localScale.z);
	}

	/**
	 * 根据节点原始旋转计算局部 X/Y/Z 分别应该承接哪个米空间轴倍率。
	 */
	private getLocalScaleForParametricAxes(target: any, worldXScale: number, worldYScale: number, worldZScale: number): Vector3 {
		const parametricX = this.getParametricMeterAxis("x");
		const parametricY = this.getParametricMeterAxis("y");
		const parametricZ = this.getParametricMeterAxis("z");
		return new Vector3(
			this.pickParametricScale(this.getNodeMeterAxis(target, "x"), parametricX, parametricY, parametricZ, worldXScale, worldYScale, worldZScale),
			this.pickParametricScale(this.getNodeMeterAxis(target, "y"), parametricX, parametricY, parametricZ, worldXScale, worldYScale, worldZScale),
			this.pickParametricScale(this.getNodeMeterAxis(target, "z"), parametricX, parametricY, parametricZ, worldXScale, worldYScale, worldZScale),
		);
	}

	/**
	 * 按节点局部轴与模型参数轴的米空间方向夹角选择缩放倍率。
	 */
	private pickParametricScale(axis: Vector3, parametricX: Vector3, parametricY: Vector3, parametricZ: Vector3, worldXScale: number, worldYScale: number, worldZScale: number): number {
		const x = Math.abs(Vector3.Dot(axis, parametricX));
		const y = Math.abs(Vector3.Dot(axis, parametricY));
		const z = Math.abs(Vector3.Dot(axis, parametricZ));
		if (y >= x && y >= z) { return worldYScale; }
		if (z >= x && z >= y) { return worldZScale; }
		return worldXScale;
	}

	/**
	 * 根据前后支架开关隐藏或显示可识别的支架节点。
	 */
	private applySupportVisibility(values: ValueMap): void {
		if ("showFrontSupport" in values) { this.setNodesEnabled(this.findNodes(/front|qian|前|zj01|support.?front|front.?support|jiao001/i), this.readBoolean(values, "showFrontSupport", true)); }
		if ("showRearSupport" in values) { this.setNodesEnabled(this.findNodes(/rear|back|hou|后|zj02|support.?rear|rear.?support|jiao004/i), this.readBoolean(values, "showRearSupport", true)); }
	}

	/**
	 * 根据模型显示开关控制状态灯等整体可见性。
	 */
	private applyModelVisibility(values: ValueMap): void {
		if ("showLight" in values) {
			const enabled = this.readBoolean(values, "showLight", true);
			const lightNodes = this.findNodes(/led|light|lamp|灯/i);
			this.setNodesEnabled(lightNodes.length > 0 ? lightNodes : this.getTemplateNodes(), enabled);
		}
	}

	/**
	 * 应用链条或辊筒位置偏移，未找到对应节点时保持原状。
	 */
	private applyPositionOffsets(values: ValueMap): void {
		if ("chainPosition" in values) { this.offsetNodes(this.findNodes(/chain|链|rail/i), new Vector3(0, 0, this.readNumber(values, "chainPosition", 0))); }
		if ("rollerPosition" in values) { this.offsetNodes(this.findNodes(/roller|辊|滚|gt\d*/i), new Vector3(this.readNumber(values, "rollerPosition", 0), 0, 0)); }
	}

	/**
	 * 应用角度类参数，默认只对模型根节点做相对旋转。
	 */
	private applyAngleParameters(values: ValueMap): void {
		if ("angle" in values) { this.rotateNodeY(this.node, this.readNumber(values, "angle", Number(DEFAULT_VALUES.angle ?? 0)) - Number(DEFAULT_VALUES.angle ?? 0)); }
		if ("wheelAngle" in values) { this.findNodes(/wheel|轮/i).forEach((node) => this.rotateNodeY(node, this.readNumber(values, "wheelAngle", Number(DEFAULT_VALUES.wheelAngle ?? 0)) - Number(DEFAULT_VALUES.wheelAngle ?? 0))); }
	}

	/**
	 * 应用货叉长度和货叉间距参数，找不到货叉节点时跳过。
	 */
        private applyForkParameters(values: ValueMap): void {
                const forkNodes = this.findStackerForkNodes();
                const primaryForkNodes = forkNodes.slice(0, 2);
                const verticalAxis = this.getParametricMeterAxis("y");
                const forkAnchors = this.captureForkVisualAnchors(primaryForkNodes, verticalAxis);
                if ("forkLength" in values) { this.scaleNodesByMeterAxes(forkNodes, this.ratioForNodesByMeterAxis(forkNodes, values, "forkLength", "x"), 1, 1); }
                if ("forkGap" in values) { this.applyForkGap(values, forkNodes, verticalAxis, forkAnchors); }
                this.restoreForkBottomAnchors(forkAnchors, verticalAxis);
                this.createForkStageTwoNodes(values, forkNodes);
        }

        /**
         * 记录货叉在原始 GLB 中的视觉底面和中心线，后续缩放或调距都以此作为贴合基准。
         */
        private captureForkVisualAnchors(forkNodes: any[], verticalAxis: Vector3): ForkVisualAnchor[] {
                return forkNodes
                        .map((node) => {
                                const bottom = this.getForkProjectedBottom(node, verticalAxis);
                                const center = this.getNodeMeterCenter(node);
                                return bottom === null || !center ? null : { node, bottom, center };
                        })
                        .filter((anchor): anchor is ForkVisualAnchor => !!anchor);
        }

        /**
         * 按原始底面投影把货叉贴回支撑平面，避免缩放 pivot 或间距轴计算带来悬浮。
         */
        private restoreForkBottomAnchors(anchors: ForkVisualAnchor[], verticalAxis: Vector3): void {
                anchors.forEach((anchor) => {
                        const currentBottom = this.getForkProjectedBottom(anchor.node, verticalAxis);
                        if (currentBottom === null) { return; }
                        const delta = anchor.bottom - currentBottom;
                        if (Math.abs(delta) < 0.0001) { return; }
                        this.translateNodeByCurrentMeterDelta(anchor.node, verticalAxis.scale(delta));
                });
        }

        /**
         * 读取单根货叉沿模型竖直轴的最低投影值，用作视觉贴合底面。
         */
        private getForkProjectedBottom(node: any, verticalAxis: Vector3): number | null {
                const bounds = this.getMeterProjectedBounds(this.getMeshesForNodes([node]), verticalAxis);
                return bounds ? bounds.min : null;
        }

	/**
	 * 为每侧货叉创建第二段伸缩可视节点；节点只存在运行时，不写回 GLB 本体。
	 */
	private createForkStageTwoNodes(values: ValueMap, forkNodes: any[]): void {
		const stageTwoReach = this.readNumber(values, "forkStageTwoReach", Number(DEFAULT_VALUES.forkStageTwoReach ?? 0));
		if (stageTwoReach <= 0) { return; }
		forkNodes.slice(0, 2).forEach((source, index) => this.cloneForkStageTwoNode(source, index === 0 ? "front" : "back"));
	}

	/**
	 * 克隆当前货叉作为第二段，初始收纳时隐藏，伸出第二段时由运行时启用。
	 */
	private cloneForkStageTwoNode(source: any, side: "front" | "back"): void {
		if (typeof source?.clone !== "function") { return; }
		const sourceName = String(source.name ?? "fork");
		const clone = source.clone(sourceName + "_stage2", source.parent, false);
		if (!clone) { return; }
		if (clone.position && source.position?.clone) { clone.position = source.position.clone(); }
		if (clone.scaling && source.scaling?.clone) { clone.scaling = source.scaling.clone(); }
		if (clone.rotation && source.rotation?.clone) { clone.rotation = source.rotation.clone(); }
		if (clone.rotationQuaternion !== undefined && source.rotationQuaternion?.clone) { clone.rotationQuaternion = source.rotationQuaternion.clone(); }
		clone.metadata = {
			...(clone.metadata ?? {}),
			generatedByParametricRuntime: true,
			sourceNodeName: sourceName,
			reason: "fork-stage-two",
			stackerForkStage: 2,
			stackerForkSide: side,
		};
		if (typeof clone.setEnabled === "function") { clone.setEnabled(false); }
		this.generatedNodes.push(clone);
	}

	/**
	 * 将货叉间距解释为两根货叉世界中心线之间的目标距离，而不是在原始位置上继续追加偏移。
	 */
        private applyForkGap(values: ValueMap, forkNodes: any[], verticalAxis: Vector3, anchors: ForkVisualAnchor[]): void {
                if (forkNodes.length < 2) { return; }
                const [firstFork, secondFork] = forkNodes.slice(0, 2);
                const firstAnchorCenter = anchors.find((anchor) => anchor.node === firstFork)?.center ?? this.getNodeMeterCenter(firstFork);
                const secondAnchorCenter = anchors.find((anchor) => anchor.node === secondFork)?.center ?? this.getNodeMeterCenter(secondFork);
                const firstCurrentCenter = this.getNodeMeterCenter(firstFork);
                const secondCurrentCenter = this.getNodeMeterCenter(secondFork);
                if (!firstAnchorCenter || !secondAnchorCenter || !firstCurrentCenter || !secondCurrentCenter) { return; }
                const axis = this.getForkGapAxis(firstAnchorCenter, secondAnchorCenter, verticalAxis);
                const firstAxisValue = this.projectMeterPoint(firstCurrentCenter, axis);
                const secondAxisValue = this.projectMeterPoint(secondCurrentCenter, axis);
                const centerAxisValue = (firstAxisValue + secondAxisValue) * 0.5;
                const direction = secondAxisValue >= firstAxisValue ? 1 : -1;
                const targetGap = Math.max(0, this.readNumber(values, "forkGap", Number(DEFAULT_VALUES.forkGap ?? 0)));
                const firstTarget = centerAxisValue - direction * targetGap * 0.5;
                const secondTarget = centerAxisValue + direction * targetGap * 0.5;

                this.offsetNodeByMeterDelta(firstFork, axis.scale(firstTarget - firstAxisValue));
                this.offsetNodeByMeterDelta(secondFork, axis.scale(secondTarget - secondAxisValue));
        }

        /**
         * 计算货叉左右间距轴，并剔除模型竖直轴分量，保证 forkGap 只改变左右中心距。
         */
        private getForkGapAxis(firstCenter: Vector3, secondCenter: Vector3, verticalAxis: Vector3): Vector3 {
                const fallbackAxis = this.removeAxisComponent(this.getParametricMeterAxis("x"), verticalAxis);
                const horizontalDelta = this.removeAxisComponent(secondCenter.subtract(firstCenter), verticalAxis);
                return this.normalizeDirection(horizontalDelta, this.normalizeDirection(fallbackAxis, this.getParametricMeterAxis("x")));
        }

        /**
         * 从方向向量中移除指定轴向的投影分量，用于把左右调距限制在水平平面内。
         */
        private removeAxisComponent(direction: Vector3, axis: Vector3): Vector3 {
                return direction.subtract(axis.scale(Vector3.Dot(direction, axis)));
        }

	/**
	 * 应用载货台或货仓类参数，找不到目标节点时跳过。
	 */
	private applyPlatformParameters(values: ValueMap): void {
		const platformNodes = this.findStackerPlatformNodes();
		if ("platformLength" in values) {
			const lengthScale = this.ratioForNodesByMeterAxis(platformNodes, values, "platformLength", "x");
			this.scaleNodesByMeterAxes(platformNodes, lengthScale, 1, 1);
		}
		if ("platformHeight" in values) { this.applyStackerPlatformHeight(values, platformNodes); }
	}

	/**
	 * 应用载货台高度：只调整载货台自身，避免影响主体立柱和顶部横杆高度。
	 */
	private applyStackerPlatformHeight(values: ValueMap, platformNodes: any[]): void {
		const platformMeshes = this.getStackerPlatformMeshes(platformNodes);
		const heightAxis = this.getParametricMeterAxis("y");
		const platformBounds = this.getMeterProjectedBounds(platformMeshes, heightAxis);
		if (!platformBounds) { return; }
		const profile = this.getPlatformHeightProfile(platformMeshes, platformBounds, heightAxis);
		if (!profile) { return; }
		const sourceHeight = platformBounds.max - profile.bodyBottomY;
		if (sourceHeight <= 0) { return; }
		const targetHeight = this.readPositiveNumber(values, "platformHeight", sourceHeight);
		const heightScale = targetHeight / sourceHeight;
		if (Math.abs(heightScale - 1) < 0.0001) { return; }
		this.stretchPlatformMeshesByHeight(platformMeshes, platformBounds, profile, heightAxis, heightScale);
	}

	/**
	 * 识别载货台高度语义边界：主体底部、底部保护区顶部和顶部保护区底部。
	 */
	private getPlatformHeightProfile(meshes: any[], bounds: { min: number; max: number }, axis: Vector3): { bodyBottomY: number; bottomProtectTopY: number; topProtectBottomY: number } | null {
		const sourceHeight = bounds.max - bounds.min;
		if (sourceHeight <= 0) { return null; }
		const levels = this.collectProjectedLevels(meshes, axis);
		if (levels.length < 2) { return null; }
		const bodyBottomY = this.findPlatformBodyBottomY(levels, bounds);
		let bottomProtectTopY = levels[0];
		let topProtectBottomY = levels[levels.length - 1];
		let largestGap = 0;
		for (let index = 1; index < levels.length; index += 1) {
			const gap = levels[index] - levels[index - 1];
			if (gap > largestGap) {
				largestGap = gap;
				bottomProtectTopY = levels[index - 1];
				topProtectBottomY = levels[index];
			}
		}
		if (largestGap < sourceHeight * 0.2) {
			bottomProtectTopY = bodyBottomY + (bounds.max - bodyBottomY) * 0.25;
			topProtectBottomY = bounds.max - (bounds.max - bodyBottomY) * 0.25;
		}
		if (bottomProtectTopY < bodyBottomY) { bottomProtectTopY = bodyBottomY; }
		return topProtectBottomY > bottomProtectTopY ? { bodyBottomY, bottomProtectTopY, topProtectBottomY } : null;
	}

	/**
	 * 从载货台底部层级中识别主体底部，最低附件不参与高度倍率计算。
	 */
	private findPlatformBodyBottomY(levels: number[], bounds: { min: number; max: number }): number {
		const minLift = Math.max(1, (bounds.max - bounds.min) * 0.05);
		return levels.find((level) => level > bounds.min + minLift) ?? bounds.min;
	}

	/**
	 * 收集 mesh 顶点的米空间 Y 坐标层级，用于识别载货台高度保护区。
	 */
	private collectProjectedValues(meshes: any[], axis: Vector3): number[] {
		const meterSpace = this.getMeterSpaceMatrices();
		if (!meterSpace) { return []; }
		const values: number[] = [];
		meshes.forEach((mesh) => {
			const positions = this.getBaseVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
				values.push(this.projectMeterPoint(meterPoint, axis));
			}
		});
		return values;
	}

	/**
	 * 合并相近的米空间 Y 坐标层级，避免浮点误差影响最大拉伸段识别。
	 */
	private collectProjectedLevels(meshes: any[], axis: Vector3): number[] {
		const sortedValues = this.collectProjectedValues(meshes, axis).sort((a, b) => a - b);
		const levels: number[] = [];
		sortedValues.forEach((value) => {
			const last = levels[levels.length - 1];
			if (last === undefined || Math.abs(value - last) > 1) {
				levels.push(value);
			}
		});
		return levels;
	}

	/**
	 * 以载货台底部为锚点调整总高度，只让中间高度段变化，顶部细节整体平移。
	 */
	private stretchPlatformMeshesByHeight(meshes: any[], bounds: { min: number; max: number }, profile: { bodyBottomY: number; bottomProtectTopY: number; topProtectBottomY: number }, axis: Vector3, heightScale: number): void {
		const sourceHeight = bounds.max - profile.bodyBottomY;
		const sourceMiddleHeight = profile.topProtectBottomY - profile.bottomProtectTopY;
		if (sourceHeight <= 0 || sourceMiddleHeight <= 0) { return; }
		const targetHeight = Math.max(1, sourceHeight * heightScale);
		const requestedExtension = targetHeight - sourceHeight;
		const targetMiddleHeight = Math.max(1, sourceMiddleHeight + requestedExtension);
		const middleScale = targetMiddleHeight / sourceMiddleHeight;
		const effectiveExtension = targetMiddleHeight - sourceMiddleHeight;
		meshes.forEach((mesh) => this.stretchMeshBetweenAxisBand(mesh, axis, profile.bottomProtectTopY, profile.topProtectBottomY, middleScale, effectiveExtension));
	}

	/**
	 * 分段映射单个 mesh 的米空间 Y 坐标：底部保护区不动，中间段拉伸，顶部保护区整体上移。
	 */
	private stretchMeshBetweenAxisBand(mesh: any, axis: Vector3, bottomY: number, topY: number, middleScale: number, extension: number): void {
		const positions = this.getBaseVertexPositions(mesh);
		const worldMatrix = mesh.computeWorldMatrix?.(true);
		const inverseWorldMatrix = worldMatrix?.clone?.();
		const meterSpace = this.getMeterSpaceMatrices();
		if (!positions || !worldMatrix || !inverseWorldMatrix?.invert || !meterSpace) { return; }
		inverseWorldMatrix.invert();
		const sourceMiddleHeight = topY - bottomY;
		if (sourceMiddleHeight <= 0) { return; }
		const nextPositions = positions.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			const local = new Vector3(positions[index], positions[index + 1], positions[index + 2]);
			const world = Vector3.TransformCoordinates(local, worldMatrix);
			const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
			const sourceAxisValue = this.projectMeterPoint(meterPoint, axis);
			const nextAxisValue = this.mapPlatformAxisValue(sourceAxisValue, bottomY, topY, sourceMiddleHeight, middleScale, extension);
			if (Math.abs(nextAxisValue - sourceAxisValue) < 0.0001) { continue; }
			const nextMeterPoint = meterPoint.add(axis.scale(nextAxisValue - sourceAxisValue));
			const nextWorld = Vector3.TransformCoordinates(nextMeterPoint, meterSpace.entityRootWorldMatrix);
			const nextLocal = Vector3.TransformCoordinates(nextWorld, inverseWorldMatrix);
			nextPositions[index] = nextLocal.x;
			nextPositions[index + 1] = nextLocal.y;
			nextPositions[index + 2] = nextLocal.z;
		}
		this.writeVertexPositions(mesh, nextPositions);
	}

	/**
	 * 计算载货台分段高度映射后的米空间 Y 坐标，X/Z 坐标始终保持原值。
	 */
	private mapPlatformAxisValue(axisValue: number, bottomY: number, topY: number, sourceMiddleHeight: number, middleScale: number, extension: number): number {
		if (axisValue <= bottomY) { return axisValue; }
		if (axisValue >= topY) { return axisValue + extension; }
		return bottomY + (axisValue - bottomY) / sourceMiddleHeight * sourceMiddleHeight * middleScale;
	}

	/**
	 * 以米空间 Y 最低点为锚点拉伸 mesh，底部保持原位，顶部向上或向下变化。
	 */
	private stretchMeshesFromAxisMin(meshes: any[], axis: Vector3, heightScale: number): void {
		if (meshes.length === 0 || Math.abs(heightScale - 1) < 0.0001) { return; }
		const bounds = this.getMeterProjectedBounds(meshes, axis);
		if (!bounds) { return; }
		const sourceHeight = bounds.max - bounds.min;
		if (sourceHeight <= 0) { return; }
		const clampedScale = Math.max(1 / sourceHeight, heightScale);
		this.stretchMeshesAboveAxisAnchor(meshes, axis, bounds.min, clampedScale);
	}

	/**
	 * 以指定米空间 Y 锚点向上拉伸 mesh，锚点以下顶点保持原位。
	 */
	private stretchMeshesAboveAxisAnchor(meshes: any[], axis: Vector3, anchorY: number, heightScale: number): void {
		meshes.forEach((mesh) => this.stretchMeshAboveAxisAnchor(mesh, axis, anchorY, heightScale));
	}

	/**
	 * 拉伸单个 mesh 的米空间 Y 坐标，保持锚点及锚点以下顶点不动。
	 */
	private stretchMeshAboveAxisAnchor(mesh: any, axis: Vector3, anchorY: number, heightScale: number): void {
		const positions = this.getBaseVertexPositions(mesh);
		const worldMatrix = mesh.computeWorldMatrix?.(true);
		const inverseWorldMatrix = worldMatrix?.clone?.();
		const meterSpace = this.getMeterSpaceMatrices();
		if (!positions || !worldMatrix || !inverseWorldMatrix?.invert || !meterSpace) { return; }
		inverseWorldMatrix.invert();
		const nextPositions = positions.slice();
		for (let index = 0; index < nextPositions.length; index += 3) {
			const local = new Vector3(positions[index], positions[index + 1], positions[index + 2]);
			const world = Vector3.TransformCoordinates(local, worldMatrix);
			const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
			const sourceAxisValue = this.projectMeterPoint(meterPoint, axis);
			if (sourceAxisValue <= anchorY) { continue; }
			const nextAxisValue = anchorY + (sourceAxisValue - anchorY) * heightScale;
			if (Math.abs(nextAxisValue - sourceAxisValue) < 0.0001) { continue; }
			const nextMeterPoint = meterPoint.add(axis.scale(nextAxisValue - sourceAxisValue));
			const nextWorld = Vector3.TransformCoordinates(nextMeterPoint, meterSpace.entityRootWorldMatrix);
			const nextLocal = Vector3.TransformCoordinates(nextWorld, inverseWorldMatrix);
			nextPositions[index] = nextLocal.x;
			nextPositions[index + 1] = nextLocal.y;
			nextPositions[index + 2] = nextLocal.z;
		}
		this.writeVertexPositions(mesh, nextPositions);
	}

	/**
	 * 计算一组 mesh 的米空间 Y 包围范围。
	 */
	private getMeterYBounds(meshes: any[]): { min: number; max: number } | null {
		const meterSpace = this.getMeterSpaceMatrices();
		if (!meterSpace) { return null; }
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = this.getBaseVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
				min = Math.min(min, meterPoint.y);
				max = Math.max(max, meterPoint.y);
			}
		});
		return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
	}

	/**
	 * 根据辊筒密度复制可识别辊筒节点，密度为 1 时保持原模型。
	 */
	private applyRollerDensity(values: ValueMap): void {
		if (!("rollerDensity" in values)) { return; }
		const density = this.clamp(Math.round(this.readNumber(values, "rollerDensity", 1)), 1, 80);
		if (density <= 1) { return; }
		const rollers = this.findNodes(/roller|辊|滚|gt\d*/i);
		this.cloneNodes(rollers, density, (index) => new Vector3(index * this.readPositiveNumber(values, "rollerWidth", 1), 0, 0), "roller");
	}

	/**
	 * 根据数量参数复制模型模板节点，数量为 1 时保持原模型。
	 */
	private applyCountArray(values: ValueMap): void {
		if (!("count" in values)) { return; }
		const count = this.clamp(Math.round(this.readNumber(values, "count", 1)), 1, 50);
		if (count <= 1) { return; }
		this.cloneTemplate(count, (index) => new Vector3(index * this.readPositiveNumber(values, "vehicleLength", 1), 0, 0), "count");
	}

	/**
	 * 根据货架层数和列数复制模型模板节点，基础模型作为第一个货位。
	 */
	private applyShelfArray(values: ValueMap): void {
		if (!("layerCount" in values) && !("columnCount" in values)) { return; }
		const columns = this.clamp(Math.round(this.readNumber(values, "columnCount", 1)), 1, 100);
		const layers = this.clamp(Math.round(this.readNumber(values, "layerCount", 1)), 1, 20);
		const spacingX = this.readPositiveNumber(values, "cellWidth", 1) + this.readPositiveNumber(values, "postWidth", 0);
		const spacingY = this.readPositiveNumber(values, "cellHeight", 1);
		for (let column = 0; column < columns; column += 1) {
			for (let layer = 0; layer < layers; layer += 1) {
				if (column === 0 && layer === 0) { continue; }
				this.cloneTemplate(2, (index) => index === 1 ? new Vector3(column * spacingX, layer * spacingY, 0) : Vector3.Zero(), "shelf_" + column + "_" + layer);
			}
		}
	}

	/**
	 * 启用双深货位时复制一组模板节点到深位方向。
	 */
	private applyDoubleDeep(values: ValueMap): void {
		if (!this.readBoolean(values, "doubleDeepEnabled", false)) { return; }
		const z = this.readPositiveNumber(values, "cellDepth", 1) + this.readNumber(values, "deepSlotGap", 0);
		this.cloneTemplate(2, (index) => index === 1 ? new Vector3(0, this.readNumber(values, "deepSlotLift", 0), z) : Vector3.Zero(), "double_deep");
	}

	/**
	 * 应用 RGV 路线类静态参数，当前只控制轨道可见性、轨道宽度和双工模板。
	 */
	private applyRouteParameters(values: ValueMap): void {
		if ("showTrack" in values) { this.setNodesEnabled(this.findNodes(/track|rail|轨/i), this.readBoolean(values, "showTrack", true)); }
		if ("trackWidth" in values) { this.findNodes(/track|rail|轨/i).forEach((node) => this.scaleNode(node, 1, 1, this.ratio(values, "trackWidth"))); }
		if (String(values.workMode ?? "") === "dual") { this.cloneTemplate(2, (index) => index === 1 ? new Vector3(0, 0, this.readPositiveNumber(values, "trackWidth", 0.2) * 4 + 1) : Vector3.Zero(), "dual_work"); }
	}

	/**
	 * 复制模型根节点下的模板节点。
	 */
	private cloneTemplate(count: number, offsetFactory: (index: number) => Vector3, reason: string): void {
		this.cloneNodes(this.getTemplateNodes(), count, offsetFactory, reason);
	}

	/**
	 * 按指定偏移复制一组节点，第一组原始节点不复制。
	 */
	private cloneNodes(nodes: any[], count: number, offsetFactory: (index: number) => Vector3, reason: string): void {
		if (nodes.length === 0) { return; }
		for (let index = 1; index < count; index += 1) {
			const offset = offsetFactory(index);
			nodes.forEach((source) => this.cloneSingleNode(source, offset, reason, index));
		}
	}

	/**
	 * 克隆单个节点并应用偏移，克隆失败时直接跳过。
	 */
	private cloneSingleNode(source: any, offset: Vector3, reason: string, index: number): void {
		if (typeof source.clone !== "function") { return; }
		const snapshot = this.rememberSnapshot(source);
		const clone = source.clone(String(source.name ?? "node") + "_" + reason + "_" + index, source.parent, false);
		if (!clone) { return; }
		if (clone.position) { clone.position = snapshot.position.add(this.meterDeltaToParentLocalDelta(source, offset)); }
		if (clone.scaling) { clone.scaling = snapshot.scaling.clone(); }
		clone.metadata = { ...(clone.metadata ?? {}), generatedByParametricRuntime: true, sourceNodeName: source.name, reason };
		if (typeof clone.setEnabled === "function") { clone.setEnabled(true); }
		this.generatedNodes.push(clone);
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
	 * 获取用于复制的模板节点，优先使用模型根节点的直接子节点。
	 */
	private getTemplateNodes(): any[] {
		const nodes = this.getModelNodes().filter((candidate) => candidate !== this.node && candidate.parent === this.node && !candidate.metadata?.generatedByParametricRuntime);
		return nodes.length > 0 ? nodes : this.getModelNodes().filter((candidate) => candidate !== this.node && !candidate.metadata?.generatedByParametricRuntime).slice(0, 1);
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
	 * 按名称正则查找模型子树内的节点。
	 */
	private findNodes(pattern: RegExp): any[] {
		return this.getModelNodes().filter((candidate) => candidate !== this.node && pattern.test(String(candidate.name ?? "")));
	}

	/**
	 * 查找 Stacker 的整组行走机构节点，固定上下轨不参与默认原位回贴。
	 */
	private findStackerTravelNodes(): any[] {
		const configuredNames = [...dataDriven.motion.travel.nodes, ...dataDriven.motion.fork.stageTwoNodes];
		const namedNodes = this.findNodesByName(configuredNames);
		return namedNodes.length > 0
			? namedNodes
			: this.findNodes(/dingbuhuagui|dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha/i);
	}

	/**
	 * 查找 Stacker 的主体宽度节点，长轨端头不参与宽度缩放，避免红框端部变形。
	 */
	private findStackerBodyWidthNodes(): any[] {
		const lengthNodes = new Set(this.findStackerLengthNodes());
		return this.findNodes(/huagui|dingbu|dibu|lizhu|滑轨|顶部|底部|立柱/i).filter((node) => !lengthNodes.has(node));
	}

	/**
	 * 查找 Stacker 的长轨节点，长度参数只拉伸这些节点，避免操作台、立柱和货叉随轨道长度变形。
	 */
	private findStackerLengthNodes(): any[] {
		const namedNodes = this.findNodesByName(["guidaoshang.1", "guidaoxia.2"]);
		return namedNodes.length > 0 ? namedNodes : this.findNodes(/guidao|轨道|导轨/i);
	}

	/**
	 * 查找 Stacker 的两根货叉节点，精确名称优先，名称变化时再退回到货叉关键字。
	 */
	private findStackerForkNodes(): any[] {
		const namedNodes = this.findNodesByName(["huocha.9", "huocha2.10"]);
		return namedNodes.length > 0 ? namedNodes : this.findNodes(/fork|叉|huocha|cha\d*/i);
	}

	/**
	 * 查找 Stacker 的载货台节点，精确名称优先，名称变化时再退回到货仓关键字。
	 */
	private findStackerPlatformNodes(): any[] {
		const namedNodes = this.findNodesByName(["xiang.13"]);
		return namedNodes.length > 0 ? namedNodes : this.findNodes(/platform|cargo|bay|xiang|台|仓/i);
	}

	/**
	 * 查找随主体高度延展的立柱节点。
	 */
	private findStackerMastStretchNodes(): any[] {
		const namedNodes = this.findNodesByName(["lizhu1.11", "lizhu2.12"]);
		return namedNodes.length > 0 ? namedNodes : this.findNodes(/lizhu|立柱|mast|column/i);
	}

	/**
	 * 查找随主体高度整体上移的顶部轨道和横杆节点，这些节点只平移不缩放。
	 * 精确节点覆盖当前 GLB，兜底模式覆盖后续重命名的上轨/顶部结构；底轨不在此集合内，避免主体高度改变时破坏地面轨道基准。
	 */
	private findStackerTopLiftNodes(): any[] {
		const namedNodes = this.findNodesByName(["guidaoshang.1", "dingbuhuagui2.3", "dingbuhuagui1.4", "dingbu.5"]);
		const fallbackNodes = this.findNodes(/guidaoshang|dingbuhuagui|dingbu|顶部|上轨|顶轨|top|upper.*rail|rail.*top/i)
			.filter((node) => !/guidaoxia|dibu|底部|下轨|bottom|lower/i.test(String(node.name ?? "")));
		return this.uniqueNodes([...namedNodes, ...fallbackNodes]);
	}

	/**
	 * 按精确节点名查找模型子树内的节点。
	 */
	private findNodesByName(names: string[]): any[] {
		const nameSet = new Set(names);
		return this.getModelNodes().filter((candidate) => candidate !== this.node && nameSet.has(String(candidate.name ?? "")));
	}

	/**
	 * 按引用去重节点数组，保证精确命名和兜底模式同时命中时只应用一次位移。
	 */
	private uniqueNodes(nodes: any[]): any[] {
		return [...new Set(nodes)];
	}

	/**
	 * 收集 Stacker 载货台自身 mesh，显式排除主体立柱、顶部杆件、长轨和货叉，避免载货台高度误改主体高度。
	 */
	private getStackerPlatformMeshes(platformNodes: any[]): any[] {
		const excludedNodes = [
			...this.findStackerMastStretchNodes(),
			...this.findStackerTopLiftNodes(),
			...this.findStackerLengthNodes(),
			...this.findStackerForkNodes(),
		];
		const directMeshes = this.getDirectMeshesForNodes(platformNodes).filter((mesh) => !this.isNodeOrDescendantOfAny(mesh, excludedNodes));
		if (directMeshes.length > 0) { return [...new Set(directMeshes)]; }
		return this.getMeshesForNodes(platformNodes).filter((mesh) => !this.isNodeOrDescendantOfAny(mesh, excludedNodes));
	}

	/**
	 * 收集节点自身和直属子级中的可编辑 mesh，优先用于只应影响单个部件的局部高度参数。
	 */
	private getDirectMeshesForNodes(nodes: any[]): any[] {
		const meshes: any[] = [];
		nodes.forEach((node) => {
			if (this.isEditableMesh(node)) { meshes.push(node); }
			if (typeof node.getChildMeshes === "function") { meshes.push(...node.getChildMeshes(true).filter((child: any) => this.isEditableMesh(child))); }
		});
		return [...new Set(meshes)];
	}

	/**
	 * 判断节点是否属于需要排除的主体结构分组。
	 */
	private isNodeOrDescendantOfAny(node: any, ancestors: any[]): boolean {
		return ancestors.some((ancestor) => node === ancestor || node.isDescendantOf?.(ancestor));
	}

	/**
	 * 收集节点自身和子级中的 mesh，用于顶点级长度拉伸。
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
	 * 判断节点是否具备可编辑 position 顶点数据。
	 */
	private isEditableMesh(node: any): boolean {
		const positions = node?.getVerticesData?.("position");
		return !node?.isDisposed?.()
			&& node?.isEnabled?.(false) !== false
			&& node?.isVisible !== false
			&& Number(node?.visibility ?? 1) > 0
			&& typeof node?.setVerticesData === "function"
			&& !!positions
			&& positions.length > 0;
	}

	/**
	 * 批量设置节点启用状态。
	 */
	private setNodesEnabled(nodes: any[], enabled: boolean): void {
		nodes.forEach((node) => { if (typeof node.setEnabled === "function") { node.setEnabled(enabled); } });
	}

	/**
	 * 对一组节点应用位置偏移。
	 */
	private offsetNodes(nodes: any[], offset: Vector3): void {
		nodes.forEach((node) => this.offsetNode(node, offset));
	}

	/**
	 * 按米空间偏移节点，专用于顶轨随主体高度抬升；会把米空间位移换算到父节点本地坐标，兼容 GLB __root__ 的缩放和翻转。
	 */
	private offsetNodesByMeterDelta(nodes: any[], meterOffset: Vector3): void {
		nodes.forEach((node) => this.offsetNodeByMeterDelta(node, meterOffset));
	}

	/**
	 * 对单个节点应用相对基础位置的米空间偏移。
	 */
	private offsetNodeByMeterDelta(node: any, meterOffset: Vector3): void {
		const snapshot = this.rememberSnapshot(node);
		if (!node.position) { return; }
		const localOffset = this.meterDeltaToParentLocalDelta(node, meterOffset);
		node.position = snapshot.position.add(localOffset);
	}

        /**
         * 在节点当前姿态基础上追加米空间位移，用于锚点回贴，避免覆盖前面已经计算好的调距位移。
         */
	private translateNodeByCurrentMeterDelta(node: any, meterOffset: Vector3): void {
		if (!node.position) { return; }
		const localOffset = this.meterDeltaToParentLocalDelta(node, meterOffset);
		node.position = node.position.add(localOffset);
		if (typeof node.computeWorldMatrix === "function") { node.computeWorldMatrix(true); }
	}

	/**
	 * 将米空间位移转换为节点父级坐标系中的位移，避免父级缩放导致顶轨只移动千分之一。
	 */
	private meterDeltaToParentLocalDelta(node: any, meterOffset: Vector3): Vector3 {
		const meterSpace = this.getMeterSpaceMatrices();
		const parent = node?.parent;
		const parentWorldMatrix = parent?.computeWorldMatrix?.(true) ?? parent?.getWorldMatrix?.();
		const inverseParentWorldMatrix = parentWorldMatrix?.clone?.();
		if (!meterSpace || !inverseParentWorldMatrix?.invert) { return meterOffset.clone?.() ?? meterOffset; }
		inverseParentWorldMatrix.invert();
		const worldOffset = Vector3.TransformNormal(meterOffset, meterSpace.entityRootWorldMatrix);
		return Vector3.TransformNormal(worldOffset, inverseParentWorldMatrix);
	}

	/**
	 * 对单个节点应用相对基础位置的偏移。
	 */
	private offsetNode(node: any, offsetMeters: Vector3): void {
		const snapshot = this.rememberSnapshot(node);
		if (node.position) { node.position = snapshot.position.add(this.meterDeltaToParentLocalDelta(node, offsetMeters)); }
	}

	/**
	 * 按角度差对节点绕 Y 轴旋转。
	 */
	private rotateNodeY(node: any, degreeDelta: number): void {
		const snapshot = this.rememberSnapshot(node);
		if (!node.rotation) { return; }
		node.rotation = snapshot.rotation?.clone?.() ?? new Vector3(0, 0, 0);
		node.rotation.y += degreeDelta * Math.PI / 180;
	}

	/**
	 * 读取字段相对默认值的倍率，旧非长度字段继续使用该兜底逻辑。
	 */
	private ratio(values: ValueMap, key: string): number {
		const base = this.readPositiveNumber(DEFAULT_VALUES, key, 1);
		return this.readPositiveNumber(values, key, base) / base;
	}

	/**
	 * 将属性面板输入的目标米值换算为一组节点的米空间轴缩放倍率。
	 */
	private ratioForNodesByMeterAxis(nodes: any[], values: ValueMap, key: string, axis: ParametricAxisName): number {
		return this.ratioForMeshesByMeterAxis(this.getMeshesForNodes(nodes), values, key, axis);
	}

	/**
	 * 将属性面板输入的目标米值换算为一组 mesh 的米空间轴缩放倍率。
	 */
	private ratioForMeshesByMeterAxis(meshes: any[], values: ValueMap, key: string, axis: ParametricAxisName): number {
		const bounds = this.getMeterAxisBounds(meshes, axis);
		const baselineMeters = bounds ? Math.max(0, bounds.max - bounds.min) : 0;
		const fallbackMeters = baselineMeters > 0 ? baselineMeters : this.readPositiveNumber(DEFAULT_VALUES, key, 1);
		const targetMeters = this.readPositiveNumber(values, key, fallbackMeters);
		return fallbackMeters > 0 ? targetMeters / fallbackMeters : 1;
	}

	/**
	 * 读取模型当前参数轴的米空间方向；模型根节点旋转后，长宽高仍沿模型自身局部轴变化。
	 */
	private getParametricMeterAxis(axis: ParametricAxisName): Vector3 {
		return this.createLocalAxis(axis);
	}

	/**
	 * 读取任意节点局部轴在当前世界空间中的方向，父级旋转和源模型单位缩放都会参与计算。
	 */
	private getNodeMeterAxis(node: any, axis: ParametricAxisName): Vector3 {
		const meterSpace = this.getMeterSpaceMatrices();
		const localAxis = this.createLocalAxis(axis);
		const nodeWorldMatrix = node?.computeWorldMatrix?.(true) ?? node?.getWorldMatrix?.();
		if (!meterSpace || !nodeWorldMatrix) { return localAxis; }
		const worldAxis = Vector3.TransformNormal(localAxis, nodeWorldMatrix);
		const meterAxis = Vector3.TransformNormal(worldAxis, meterSpace.inverseEntityRootWorldMatrix);
		return this.normalizeDirection(meterAxis, this.getParametricMeterAxis(axis));
	}

	/**
	 * 创建模型局部参数轴的单位向量。
	 */
	/** 读取实体根世界矩阵及其逆矩阵，实体根局部坐标即脚本使用的米空间。 */
	private getMeterSpaceMatrices(): { entityRootWorldMatrix: any; inverseEntityRootWorldMatrix: any } | null {
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const inverseEntityRootWorldMatrix = entityRootWorldMatrix?.clone?.();
		if (!entityRootWorldMatrix || !inverseEntityRootWorldMatrix?.invert) { return null; }
		inverseEntityRootWorldMatrix.invert();
		return { entityRootWorldMatrix, inverseEntityRootWorldMatrix };
	}

	private createLocalAxis(axis: ParametricAxisName): Vector3 {
		if (axis === "x") { return new Vector3(1, 0, 0); }
		if (axis === "y") { return new Vector3(0, 1, 0); }
		return new Vector3(0, 0, 1);
	}

	/**
	 * 将方向向量归一化，零长度或异常值时使用调用方提供的兜底方向。
	 */
	private normalizeDirection(direction: Vector3, fallback: Vector3): Vector3 {
		const length = direction.length?.() ?? 0;
		if (!Number.isFinite(length) || length <= 0.000001) { return fallback.clone?.() ?? fallback; }
		return direction.scale(1 / length);
	}

	/**
	 * 把世界坐标投影到指定米空间方向上，返回一维参数坐标。
	 */
	private projectMeterPoint(point: Vector3, axis: Vector3): number {
		return Vector3.Dot(point, axis);
	}

	/**
	 * 按任意米空间方向读取 mesh 基线投影范围，避免模型旋转后仍读取固定 world X/Y/Z。
	 */
	private getMeterProjectedBounds(meshes: any[], axis: Vector3): { min: number; max: number } | null {
		const meterSpace = this.getMeterSpaceMatrices();
		if (!meterSpace) { return null; }
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		meshes.forEach((mesh) => {
			const positions = this.getBaseVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
				const value = this.projectMeterPoint(meterPoint, axis);
				min = Math.min(min, value);
				max = Math.max(max, value);
			}
		});
		return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
	}

	/**
	 * 按指定米空间轴读取 mesh 基线包围范围。
	 */
	private getMeterAxisBounds(meshes: any[], axis: ParametricAxisName): { min: number; max: number } | null {
		return this.getMeterProjectedBounds(meshes, this.getParametricMeterAxis(axis));
	}

	/**
	 * 计算一组 mesh 的米空间 X 包围范围。
	 */
	/**
	 * 读取节点子树原始顶点的米空间包围中心，用于把尺寸参数转换成稳定的世界坐标目标。
	 */
	private getNodeMeterCenter(node: any): Vector3 | null {
		const meterSpace = this.getMeterSpaceMatrices();
		if (!meterSpace) { return null; }
		const meshes = this.getMeshesForNodes([node]);
		let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
		meshes.forEach((mesh) => {
			const positions = this.getBaseVertexPositions(mesh);
			const worldMatrix = mesh.computeWorldMatrix?.(true);
			if (!positions || !worldMatrix) { return; }
			for (let index = 0; index < positions.length; index += 3) {
				const world = Vector3.TransformCoordinates(new Vector3(positions[index], positions[index + 1], positions[index + 2]), worldMatrix);
				const meterPoint = Vector3.TransformCoordinates(world, meterSpace.inverseEntityRootWorldMatrix);
				min = Vector3.Minimize(min, meterPoint);
				max = Vector3.Maximize(max, meterPoint);
			}
		});
		if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) { return null; }
		return min.add(max).scale(0.5);
	}

	/**
	 * 根据两根货叉基线中心的最大差值选择间距方向，避免把局部轴误当成米空间轴。
	 */
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
	 * 将数值限制在指定范围内。
	 */
	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}
}
