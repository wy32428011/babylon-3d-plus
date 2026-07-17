// 此文件由模型包参数脚本和运行脚本合并而成，供编辑器以单个 TS 文件读取。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { visibleAsBoolean, visibleAsNumber, visibleAsString } from "babylonjs-editor-tools";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
// 参数长度统一使用米；contentRoot 的基础 scaling 已由编辑器包含源单位换算。

// 此文件按模型参数化说明生成，用于 多穿货架 的静态参数配置。
// 当前版本按 Shelf.glb 的真实节点结构做部件级变形，避免根节点整体拉伸。

/** 管理 多穿货架 在 Babylon.js Editor Inspector 中展示的静态参数。 */
export class ParametricModelParamsComponent {
	@visibleAsString("模型标识")
	public modelKey: string = "shelf";

	@visibleAsString("设备类型")
	public deviceType: string = "多穿库";

	@visibleAsString("设备名称")
	public deviceName: string = "多穿货架";

	@visibleAsString("参数说明")
	public description: string = "Shelf.glb 专用参数化：底部支架腿高度独立于货架高度；底部深向支撑和下方黄色横梁只保留一次，每增加一层只新增一组上方黄色框架和一组两侧三角支架；宽度、深度、列数和双深仍按模型局部轴适配。";

	@visibleAsNumber("层数", { step: 1 })
	public layerCount: number = 1;

	@visibleAsNumber("列数", { step: 1 })
	public columnCount: number = 1;

	@visibleAsNumber("单元宽度 (m)", { step: 0.1 })
	public cellWidth: number = 0.801;

	@visibleAsNumber("单元高度 (m)", { step: 0.1 })
	public cellHeight: number = 4.525;

	@visibleAsNumber("支撑脚高度 (m)", { step: 0.05 })
	public supportLegHeight: number = 0.904;

	@visibleAsNumber("单元深度 (m)", { step: 0.1 })
	public cellDepth: number = 1.183;

	@visibleAsNumber("立柱宽度 (m)", { step: 0.01 })
	public postWidth: number = 0.08;

	@visibleAsBoolean("启用双深货位")
	public doubleDeepEnabled: boolean = false;

	@visibleAsNumber("深位间隔 (m)", { step: 0.05 })
	public deepSlotGap: number = 0.2;

	@visibleAsNumber("深位提升 (m)", { step: 0.05 })
	public deepSlotLift: number = 0;

	/** 创建 多穿货架 参数配置组件。 */
	public constructor(public node: TransformNode) {}

	/** 参数组件只负责保存 Inspector 字段，运行时由 ParametricModelRuntimeComponent 读取并应用。 */
	public onStart(): void {
		// 静态参数会保存到 metadata.scripts[].values，供同目录运行脚本读取。
	}
}

type ValueMap = Record<string, unknown>;

interface NodeSnapshot {
	position: Vector3;
	scaling: Vector3;
	rotation?: Vector3;
	rotationQuaternion?: any;
	enabled?: boolean;
	visibility?: number;
	isVisible?: boolean;
	isPickable?: boolean;
}

interface AxisBounds {
	minimum: number;
	maximum: number;
	center: number;
	size: number;
}

interface ShelfPart {
	node: any;
	baseName: string;
}

interface ShelfAxisLayout {
	source: AxisBounds;
	target: AxisBounds;
	scale: number;
}

interface ShelfColumnLayout {
	spacing: number;
	startCenter: number | null;
	tolerance: number;
}

interface DenseShelfGridPlan {
	part: ShelfPart;
	depth: number;
	column: number;
	layer: number;
	offset: Vector3;
	reason: string;
}

const DEFAULT_VALUES: ValueMap = {
	modelKey: "shelf",
	deviceType: "多穿库",
	deviceName: "多穿货架",
	description: "Shelf.glb 专用参数化：底部支架腿高度独立于货架高度；底部深向支撑和下方黄色横梁只保留一次，每增加一层只新增一组上方黄色框架和一组两侧三角支架；宽度、深度、列数和双深仍按模型局部轴适配。",
	layerCount: 1,
	columnCount: 1,
	cellWidth: 0.801,
	cellHeight: 4.525,
	supportLegHeight: 0.904,
	cellDepth: 1.183,
	postWidth: 0.08,
	doubleDeepEnabled: false,
	deepSlotGap: 0.2,
	deepSlotLift: 0
};

const POST_NODE_NAMES = ["Box004", "Box001", "Box002", "Box003", "node5", "node7", "node9", "node11"];
const FOOT_NODE_NAMES = ["Jiao001", "Jiao002", "Jiao003", "Jiao004", "node27", "node29", "node31", "node33"];
const WIDTH_STRETCH_NODE_NAMES = ["Box023", "Box021", "Box032", "Box031", "node1", "node3", "node25", "node35"];
const ENDPOINT_ANCHOR_NODE_NAMES = WIDTH_STRETCH_NODE_NAMES;
const SIDE_TRIANGLE_BRACE_NODE_NAMES = ["Box008", "Box007", "node15", "node21"];
const DEPTH_BEAM_NODE_NAMES = ["Box020", "Box005", "Box006", "Box022", "node13", "node17", "node19", "node23"];
const DEPTH_STRETCH_NODE_NAMES = DEPTH_BEAM_NODE_NAMES;
const BASE_DEPTH_SUPPORT_NODE_NAMES = ["Box005", "Box006", "node17", "node19"];
const LOWER_CROSSBEAM_NODE_NAMES = ["Box032", "Box031", "node25", "node35"];
const UPPER_LAYER_FRAME_NODE_NAMES = ["Box023", "Box021", "Box020", "Box022", "node1", "node3", "node13", "node23"];
const REPEATABLE_LAYER_NODE_NAMES = [...UPPER_LAYER_FRAME_NODE_NAMES, ...SIDE_TRIANGLE_BRACE_NODE_NAMES];
const SHELF_PART_NODE_NAMES = [
	...POST_NODE_NAMES,
	...FOOT_NODE_NAMES,
	...WIDTH_STRETCH_NODE_NAMES,
	...DEPTH_STRETCH_NODE_NAMES,
	...SIDE_TRIANGLE_BRACE_NODE_NAMES
];

const MIN_DIMENSION = 0.001;
const MAX_LAYER_COUNT = 100;
const MAX_COLUMN_COUNT = 100;
const MAX_GENERATED_NODES = 5000;
const MAX_DENSE_THIN_INSTANCES = 250000;

/** 根据 Inspector 参数对 Shelf.glb 执行部件级静态参数化调整。 */
export class ParametricModelRuntimeComponent {
	private readonly snapshots = new Map<any, NodeSnapshot>();
	private readonly generatedNodes: any[] = [];
	private readonly denseHiddenNodes = new Set<any>();
	private lastSignature = "";

	/** 创建 Shelf.glb 静态参数化运行组件。 */
	public constructor(public node: TransformNode) {}

	/** 启动时记录原始状态，并立即应用当前静态参数。 */
	public onStart(): void {
		this.captureSnapshots();
		this.applyIfNeeded(true);
	}

	/** 每帧检测参数签名变化，变化后恢复基线再重新应用。 */
	public onUpdate(): void {
		this.applyIfNeeded(false);
	}

	/** 停止脚本时清理生成节点，并恢复模型导入时的基础状态。 */
	public onStop(): void {
		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
		this.lastSignature = "";
	}

	/** 在参数变化或强制刷新时重新应用 Shelf 专用节点规则。 */
	private applyIfNeeded(force: boolean): void {
		const values = this.readParamValues();
		const signature = JSON.stringify(values);
		if (!force && signature === this.lastSignature) {
			return;
		}

		this.disposeGeneratedNodes();
		this.restoreBaseNodes();
		this.applyShelfParameters(values);
		this.lastSignature = signature;
	}

	/** 记录当前模型根节点和所有子节点的基础变换与启用状态。 */
	private captureSnapshots(): void {
		this.getModelNodes().forEach((target) => this.rememberSnapshot(target));
	}

	/** 保存单个节点的基础状态，后续所有参数应用都以该状态为基线。 */
	private rememberSnapshot(target: any): NodeSnapshot {
		if (!this.snapshots.has(target)) {
			this.snapshots.set(target, {
				position: target.position?.clone?.() ?? Vector3.Zero(),
				scaling: target.scaling?.clone?.() ?? new Vector3(1, 1, 1),
				rotation: target.rotation?.clone?.(),
				rotationQuaternion: target.rotationQuaternion?.clone?.(),
				enabled: typeof target.isEnabled === "function" ? target.isEnabled() : undefined,
				visibility: typeof target.visibility === "number" ? target.visibility : undefined,
				isVisible: typeof target.isVisible === "boolean" ? target.isVisible : undefined,
				isPickable: typeof target.isPickable === "boolean" ? target.isPickable : undefined
			});
		}
		return this.snapshots.get(target) ?? { position: Vector3.Zero(), scaling: new Vector3(1, 1, 1) };
	}

	/** 将所有已记录节点恢复到导入时的基础状态。 */
	private restoreBaseNodes(): void {
		this.snapshots.forEach((snapshot, target) => {
			if (target.position) {
				target.position = snapshot.position.clone();
			}
			if (target.scaling) {
				target.scaling = snapshot.scaling.clone();
			}
			if (target.rotation && snapshot.rotation) {
				target.rotation = snapshot.rotation.clone();
			}
			if (target.rotationQuaternion !== undefined) {
				target.rotationQuaternion = snapshot.rotationQuaternion?.clone?.() ?? null;
			}
			if (snapshot.visibility !== undefined) {
				target.visibility = snapshot.visibility;
			}
			if (snapshot.isVisible !== undefined) {
				target.isVisible = snapshot.isVisible;
			}
			if (snapshot.isPickable !== undefined) {
				target.isPickable = snapshot.isPickable;
			}
			if (snapshot.enabled !== undefined && typeof target.setEnabled === "function") {
				target.setEnabled(snapshot.enabled);
			}
		});
		this.denseHiddenNodes.clear();
	}

	/** 从模型 metadata 和运行实例属性中读取参数值，缺失时使用脚本内置默认值。 */
	private readParamValues(): ValueMap {
		const scriptValues = this.readScriptParamValues();
		const mergedValues = { ...DEFAULT_VALUES, ...scriptValues };
		return {
			...mergedValues,
			layerCount: this.readNumber({ layerCount: this.readRuntimeValue("layerCount", mergedValues.layerCount) }, "layerCount", Number(DEFAULT_VALUES.layerCount)),
			columnCount: this.readNumber({ columnCount: this.readRuntimeValue("columnCount", mergedValues.columnCount) }, "columnCount", Number(DEFAULT_VALUES.columnCount)),
			cellWidth: this.readNumber({ cellWidth: this.readRuntimeValue("cellWidth", mergedValues.cellWidth) }, "cellWidth", Number(DEFAULT_VALUES.cellWidth)),
			cellHeight: this.readNumber({ cellHeight: this.readRuntimeValue("cellHeight", mergedValues.cellHeight) }, "cellHeight", Number(DEFAULT_VALUES.cellHeight)),
			supportLegHeight: this.readNumber({ supportLegHeight: this.readRuntimeValue("supportLegHeight", mergedValues.supportLegHeight) }, "supportLegHeight", Number(DEFAULT_VALUES.supportLegHeight)),
			cellDepth: this.readNumber({ cellDepth: this.readRuntimeValue("cellDepth", mergedValues.cellDepth) }, "cellDepth", Number(DEFAULT_VALUES.cellDepth)),
			postWidth: this.readNumber({ postWidth: this.readRuntimeValue("postWidth", mergedValues.postWidth) }, "postWidth", Number(DEFAULT_VALUES.postWidth)),
			doubleDeepEnabled: this.readBoolean({ doubleDeepEnabled: this.readRuntimeValue("doubleDeepEnabled", mergedValues.doubleDeepEnabled) }, "doubleDeepEnabled", Boolean(DEFAULT_VALUES.doubleDeepEnabled)),
			deepSlotGap: this.readNumber({ deepSlotGap: this.readRuntimeValue("deepSlotGap", mergedValues.deepSlotGap) }, "deepSlotGap", Number(DEFAULT_VALUES.deepSlotGap)),
			deepSlotLift: this.readNumber({ deepSlotLift: this.readRuntimeValue("deepSlotLift", mergedValues.deepSlotLift) }, "deepSlotLift", Number(DEFAULT_VALUES.deepSlotLift))
		};
	}

	/** 优先读取编辑器注入到运行实例上的实时参数，未注入时保留 metadata 中的参数值。 */
	private readRuntimeValue(key: string, fallback: unknown): unknown {
		const value = (this as Record<string, unknown>)[key];
		return value === undefined ? fallback : value;
	}

	/** 从 metadata.scripts[] 中读取参数脚本保存的 values。 */
	private readScriptParamValues(): ValueMap {
		const scripts = Array.isArray(this.node.metadata?.scripts) ? this.node.metadata.scripts : [];
		for (const script of scripts) {
			const scriptName = String(script?.className ?? script?.name ?? script?.scriptFilename ?? "");
			const values = {
				...this.readFieldDefaults(script),
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

	/** 读取 meta 字段列表中的默认值，保证 Inspector 尚未保存时也能取得参数。 */
	private readFieldDefaults(script: any): ValueMap {
		const fields = Array.isArray(script?.fields) ? script.fields : [];
		return fields.reduce((result: ValueMap, field: any) => {
			const key = String(field?.key ?? field?.propertyKey ?? "");
			if (key) {
				result[key] = field.defaultValue ?? field.value;
			}
			return result;
		}, {});
	}

	/** 将 values/properties/config 的包装结构转换为普通键值表。 */
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

	/** 读取 Shelf 部件并按宽、高、深、底腿、层数和列数生成目标形态。 */
	private applyShelfParameters(values: ValueMap): void {
		const parts = this.getShelfParts();
		const bounds = this.getNodesMeterBounds(parts.map((part) => part.node));
		if (!bounds || parts.length === 0) {
			return;
		}

		const targetWidth = this.readPositiveNumber(values, "cellWidth", bounds.size.x);
		const targetHeight = this.readPositiveNumber(values, "cellHeight", bounds.size.y);
		const targetSupportLegHeight = this.readPositiveNumber(values, "supportLegHeight", Number(DEFAULT_VALUES.supportLegHeight));
		const targetDepth = this.readPositiveNumber(values, "cellDepth", bounds.size.z);
		const postWidth = this.readPositiveNumber(values, "postWidth", Number(DEFAULT_VALUES.postWidth));
		const layers = this.clamp(Math.round(this.readNumber(values, "layerCount", 1)), 1, MAX_LAYER_COUNT);
		const columns = this.clamp(Math.round(this.readNumber(values, "columnCount", 1)), 1, MAX_COLUMN_COUNT);
		const sourceSupportLegHeight = this.getSourceSupportLegHeight(parts, bounds.minimum.y);
		const supportLegDelta = targetSupportLegHeight - sourceSupportLegHeight;
		const supportLegHeightRatio = this.createSafeRatio(targetSupportLegHeight, sourceSupportLegHeight);
		const targetLayerSpan = Math.max(MIN_DIMENSION, targetHeight - Number(DEFAULT_VALUES.supportLegHeight));
		const targetSingleLayerHeight = targetSupportLegHeight + targetLayerSpan;

		this.applySingleLayerDimensions(parts, bounds, targetWidth, targetDepth, supportLegDelta, supportLegHeightRatio, targetSingleLayerHeight);
		this.applyPostCrossSection(parts, postWidth);
		this.applyPostTotalHeight(parts, bounds, targetSupportLegHeight + targetLayerSpan * layers);
		const columnLayout = this.createColumnLayout(parts, targetWidth);
		this.cloneShelfGrid(parts, values, layers, columns, targetLayerSpan, columnLayout, targetDepth);
	}

	/** 对原始第一层应用宽深尺寸、底腿高度和上方框架高度，贴地支撑保持原位。 */
	private applySingleLayerDimensions(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetWidth: number, targetDepth: number, supportLegDelta: number, supportLegHeightRatio: number, targetSingleLayerHeight: number): void {
		this.applyShelfWidthLayout(parts, bounds, targetWidth);
		this.applyShelfDepthLayout(parts, bounds, targetDepth);

		parts.filter((part) => this.isLowerCrossbeamPart(part)).forEach((part) => {
			this.moveNodeMeterAxisBy(part.node, "y", supportLegDelta);
		});
		parts.filter((part) => this.isSideTriangleBracePart(part)).forEach((part) => {
			const nodeBounds = this.getNodesMeterAxisBounds([part.node], "y");
			if (nodeBounds) {
				this.fitNodeMeterAxisToBounds(part.node, "y", "z", this.createHeightScaledBounds(nodeBounds, bounds.minimum.y, supportLegHeightRatio));
			}
		});
		const upperFrameDelta = targetSingleLayerHeight - bounds.size.y;
		parts.filter((part) => this.isUpperLayerFramePart(part)).forEach((part) => {
			this.moveNodeMeterAxisBy(part.node, "y", upperFrameDelta);
		});
	}

	/** 读取原始下方黄色横梁中心相对模型底部的高度，作为底腿参数的稳定基准。 */
	private getSourceSupportLegHeight(parts: ShelfPart[], sourceMinimum: number): number {
		const lowerCrossbeamBounds = this.getNodesMeterAxisBounds(
			parts.filter((part) => this.isLowerCrossbeamPart(part)).map((part) => part.node),
			"y"
		);
		if (!lowerCrossbeamBounds) {
			return Number(DEFAULT_VALUES.supportLegHeight);
		}
		return Math.max(MIN_DIMENSION, lowerCrossbeamBounds.center - sourceMinimum);
	}

	/** 以四个跨宽节点的新左右端点作为锚点，让连接件随端点移动而不是按整体比例漂移。 */
	private applyShelfWidthLayout(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetWidth: number): void {
		const layout = this.createShelfWidthLayout(parts, bounds, targetWidth);
		parts.filter((part) => this.isWidthStretchPart(part)).forEach((part) => this.applyWidthStretchPart(part, layout));
		parts.filter((part) => !this.isWidthStretchPart(part)).forEach((part) => this.moveConnectedPartWithWidthEndpoint(part, layout));
	}

	/** 根据 node1/node3/node25/node35 对应节点推导宽度变形的原始端点和目标端点。 */
	private createShelfWidthLayout(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetWidth: number): ShelfAxisLayout {
		return this.createShelfAxisLayout(this.getEndpointAnchorNodes(parts), "x", bounds, targetWidth);
	}

	/** 拉伸指定跨宽节点，并在缩放后重新贴回目标端点区间。 */
	private applyWidthStretchPart(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesMeterAxisBounds([part.node], "x");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeMeterAxisToBounds(part.node, "x", "x", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 非跨宽连接件保持相对最近端点的原始偏移，随跨宽节点端点一起外移或内收。 */
	private moveConnectedPartWithWidthEndpoint(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesMeterAxisBounds([part.node], "x");
		if (!nodeBounds || !part.node.position) {
			return;
		}
		this.moveNodeMeterAxisBy(part.node, "x", this.getEndpointConnectedCenter(nodeBounds, layout) - nodeBounds.center);
	}

	/** 以四个跨宽节点的新前后端点作为锚点，让立柱和层板随深度边界移动。 */
	private applyShelfDepthLayout(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetDepth: number): void {
		const layout = this.createShelfDepthLayout(parts, bounds, targetDepth);
		parts.filter((part) => this.isDepthStretchPart(part)).forEach((part) => this.applyDepthStretchPart(part, layout));
		parts.filter((part) => this.isSideTriangleBracePart(part)).forEach((part) => this.applySideTriangleBraceDepthPart(part, layout));
		parts.filter((part) => !this.isDepthStretchPart(part) && !this.isSideTriangleBracePart(part)).forEach((part) => this.moveConnectedPartWithDepthEndpoint(part, layout));
	}

	/** 根据跨宽层梁的真实 mesh 包围盒推导深度变形的原始前后端点和目标端点。 */
	private createShelfDepthLayout(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetDepth: number): ShelfAxisLayout {
		return this.createShelfAxisLayout(this.getEndpointAnchorNodes(parts), "z", bounds, targetDepth);
	}

	/** 拉伸深度梁或侧撑，并在缩放后重新贴回目标前后端点区间。 */
	private applyDepthStretchPart(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesMeterAxisBounds([part.node], "z");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeMeterAxisToBounds(part.node, "z", "y", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 侧面三角斜撑独立适配深度端点，避免与普通水平深度梁混用分类。 */
	private applySideTriangleBraceDepthPart(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesMeterAxisBounds([part.node], "z");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeMeterAxisToBounds(part.node, "z", "y", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 非深度拉伸部件保持相对最近前后端点的原始偏移，随新深度边界移动。 */
	private moveConnectedPartWithDepthEndpoint(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesMeterAxisBounds([part.node], "z");
		if (!nodeBounds || !part.node.position) {
			return;
		}
		this.moveNodeMeterAxisBy(part.node, "z", this.getEndpointConnectedCenter(nodeBounds, layout) - nodeBounds.center);
	}

	/** 计算通用端点布局，保留跨宽节点之外的固定外沿余量。 */
	private createShelfAxisLayout(nodes: any[], axis: "x" | "z", bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetSize: number): ShelfAxisLayout {
		const source = this.getNodesMeterAxisBounds(nodes, axis) ?? {
			minimum: bounds.minimum[axis],
			maximum: bounds.maximum[axis],
			center: bounds.center[axis],
			size: bounds.size[axis]
		};
		const fixedSideOverhang = Math.max(0, bounds.size[axis] - source.size);
		const targetStretchSize = Math.max(MIN_DIMENSION, targetSize - fixedSideOverhang);
		const target = {
			minimum: source.center - targetStretchSize / 2,
			maximum: source.center + targetStretchSize / 2,
			center: source.center,
			size: targetStretchSize
		};
		return { source, target, scale: this.createSafeRatio(target.size, source.size) };
	}

	/** 获取宽度和深度共同使用的端点锚点，不能替换为父节点 position 或深度梁集合。 */
	private getEndpointAnchorNodes(parts: ShelfPart[]): any[] {
		return parts.filter((part) => this.matchesAnyBaseName(part.baseName, ENDPOINT_ANCHOR_NODE_NAMES)).map((part) => part.node);
	}

	/** 为可拉伸部件生成目标端点，保留它相对总锚点两端的原始搭接量。 */
	private createEndpointAnchoredBounds(nodeBounds: AxisBounds, layout: ShelfAxisLayout): AxisBounds {
		const minimum = layout.target.minimum + (nodeBounds.minimum - layout.source.minimum);
		const maximum = layout.target.maximum + (nodeBounds.maximum - layout.source.maximum);
		if (maximum - minimum > MIN_DIMENSION) {
			return { minimum, maximum, center: (minimum + maximum) / 2, size: maximum - minimum };
		}

		const center = this.getEndpointConnectedCenter(nodeBounds, layout);
		const size = Math.max(MIN_DIMENSION, Math.min(nodeBounds.size, layout.target.size));
		return { minimum: center - size / 2, maximum: center + size / 2, center, size };
	}

	/** 侧面三角斜撑以模型底部为锚点随底腿高度缩放，保证下端贴近底部支撑、上端跟随黄色横梁。 */
	private createHeightScaledBounds(nodeBounds: AxisBounds, sourceMinimum: number, heightRatio: number): AxisBounds {
		const minimum = sourceMinimum + (nodeBounds.minimum - sourceMinimum) * heightRatio;
		const maximum = sourceMinimum + (nodeBounds.maximum - sourceMinimum) * heightRatio;
		const size = Math.max(MIN_DIMENSION, maximum - minimum);
		return { minimum, maximum, center: (minimum + maximum) / 2, size };
	}

	/** 计算连接件的新中心：靠近最小端跟最小端，靠近最大端跟最大端，中间件才按中心比例移动。 */
	private getEndpointConnectedCenter(nodeBounds: AxisBounds, layout: ShelfAxisLayout): number {
		const centerDeadZone = Math.max(MIN_DIMENSION, layout.source.size * 0.08);
		if (nodeBounds.center < layout.source.center - centerDeadZone) {
			return layout.target.minimum + (nodeBounds.center - layout.source.minimum);
		}
		if (nodeBounds.center > layout.source.center + centerDeadZone) {
			return layout.target.maximum + (nodeBounds.center - layout.source.maximum);
		}
		return layout.target.center + (nodeBounds.center - layout.source.center) * layout.scale;
	}

	/** 按 postWidth/0.08 的兼容比例修改立柱本地 X/Y 横截面，保持本地 Z 高度轴和列中心距不变。 */
	private applyPostCrossSection(parts: ShelfPart[], postWidth: number): void {
		const scaleRatio = this.createSafeRatio(Math.max(MIN_DIMENSION, postWidth), Number(DEFAULT_VALUES.postWidth));
		parts.filter((part) => this.isPostPart(part)).forEach((part) => {
			if (!part.node.scaling) {
				return;
			}
			const snapshot = this.rememberSnapshot(part.node);
			part.node.scaling.x = snapshot.scaling.x * scaleRatio;
			part.node.scaling.y = snapshot.scaling.y * scaleRatio;
		});
	}

	/** 动态读取全部立柱当前 Y 投影底端，保持底端不下沉，只把顶端向上延伸到整架总高度。 */
	private applyPostTotalHeight(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, totalHeight: number): void {
		const postMinimum = this.getPostMinimumY(parts);
		if (postMinimum === null) {
			return;
		}
		const targetMaximum = Math.max(postMinimum + MIN_DIMENSION, bounds.minimum.y + Math.max(MIN_DIMENSION, totalHeight));
		const targetBounds: AxisBounds = {
			minimum: postMinimum,
			maximum: targetMaximum,
			center: (postMinimum + targetMaximum) / 2,
			size: Math.max(MIN_DIMENSION, targetMaximum - postMinimum)
		};
		parts.filter((part) => this.isPostPart(part)).forEach((part) => this.fitNodeMeterAxisToBounds(part.node, "y", "z", targetBounds));
	}

	/** 汇总全部立柱当前世界 Y 轴投影最低点，作为高度拉伸时不变的底端锚点。 */
	private getPostMinimumY(parts: ShelfPart[]): number | null {
		const minimums = parts
			.filter((part) => this.isPostPart(part))
			.map((part) => this.getNodesMeterAxisBounds([part.node], "y")?.minimum)
			.filter((minimum): minimum is number => typeof minimum === "number" && Number.isFinite(minimum));
		return minimums.length > 0 ? Math.min(...minimums) : null;
	}

	/** 按层、列、深位组合复制 Shelf；低密度保留逐节点 clone，高密度切换为 thin-instance 批次避免节点爆炸。 */
	private cloneShelfGrid(parts: ShelfPart[], values: ValueMap, layers: number, columns: number, spacingY: number, columnLayout: ShelfColumnLayout, targetDepth: number): any[] {
		const partMeshes = this.createPartRenderableMeshMap(parts);
		const plan = this.createShelfGridPlan(parts, values, layers, columns, spacingY, columnLayout, targetDepth);
		const estimatedGeneratedNodes = plan.reduce((count, item) => count + (partMeshes.get(item.part)?.length ?? 0), 0);
		if (estimatedGeneratedNodes > MAX_GENERATED_NODES) {
			return this.createDenseShelfGridBatches(parts, plan, partMeshes);
		}

		const clones: any[] = [];
		let cloneIndex = 1;
		plan.forEach((item) => {
			cloneIndex = this.clonePartWithIndex(item.part.node, item.offset, item.reason, cloneIndex, clones);
		});
		return clones;
	}

	/** 生成完整层/列/深位复制计划；高低密度共用，避免两条路径的结构规则漂移。 */
	private createShelfGridPlan(parts: ShelfPart[], values: ValueMap, layers: number, columns: number, spacingY: number, columnLayout: ShelfColumnLayout, targetDepth: number): DenseShelfGridPlan[] {
		const plan: DenseShelfGridPlan[] = [];
		const depthCount = this.readBoolean(values, "doubleDeepEnabled", false) ? 2 : 1;
		const deepOffsetZ = targetDepth + this.readNumber(values, "deepSlotGap", 0);
		const deepOffsetY = this.readNumber(values, "deepSlotLift", 0);

		for (let depth = 0; depth < depthCount; depth += 1) {
			for (let column = 0; column < columns; column += 1) {
				for (let layer = 0; layer < layers; layer += 1) {
					if (depth === 0 && column === 0 && layer === 0) {
						continue;
					}
					const offset = this.createShelfGridOffset(column, layer, depth, columnLayout.spacing, spacingY, deepOffsetZ, deepOffsetY);
					parts.forEach((part) => {
						if (!this.shouldClonePartForGridCell(part, column, layer, columnLayout)) {
							return;
						}
						const reason = this.isSideTriangleBracePart(part)
							? `shelf_brace_d${depth}_c${column}_l${layer}`
							: `shelf_grid_d${depth}_c${column}_l${layer}`;
						plan.push({ part, depth, column, layer, offset, reason });
					});
				}
			}
		}
		return plan;
	}

	/** 为高密度 Shelf 创建每个可渲染叶 Mesh 一个批次，重复单元使用 thin-instance 矩阵表示。 */
	private createDenseShelfGridBatches(parts: ShelfPart[], plan: DenseShelfGridPlan[], partMeshes: Map<ShelfPart, any[]>): any[] {
		const batches: any[] = [];
		const sourcePlans = new Map<any, DenseShelfGridPlan[]>();
		parts.forEach((part) => {
			(partMeshes.get(part) ?? []).forEach((mesh) => {
				if (!sourcePlans.has(mesh)) {
					sourcePlans.set(mesh, [{ part, depth: 0, column: 0, layer: 0, offset: Vector3.Zero(), reason: "shelf_dense_base" }]);
				}
			});
		});
		plan.forEach((item) => {
			(partMeshes.get(item.part) ?? []).forEach((mesh) => {
				const entries = sourcePlans.get(mesh) ?? [];
				entries.push(item);
				sourcePlans.set(mesh, entries);
			});
		});

		let totalInstances = 0;
		let batchIndex = 1;
		for (const [sourceMesh, entries] of sourcePlans.entries()) {
			totalInstances += entries.length;
			if (totalInstances > MAX_DENSE_THIN_INSTANCES) {
				throw new Error(`Shelf 高密度 thin-instance 数量 ${totalInstances} 超过安全上限 ${MAX_DENSE_THIN_INSTANCES}，请降低层/列/双深参数。`);
			}
			const batch = this.createDenseBatchMesh(sourceMesh, entries, batchIndex);
			if (batch) {
				batches.push(batch);
				batchIndex += 1;
			}
		}
		this.node.metadata = {
			...(this.node.metadata ?? {}),
			shelfDenseBatch: { enabled: true, batchCount: batches.length, thinInstanceCount: totalInstances }
		};
		return batches;
	}

	/** 创建单个源叶 Mesh 的高密度批次 Mesh，并把源 Mesh 相对参数根的基准变换烘焙进独立几何。 */
	private createDenseBatchMesh(sourceMesh: any, entries: DenseShelfGridPlan[], batchIndex: number): any | null {
		const geometrySource = sourceMesh?.isAnInstance === true ? sourceMesh.sourceMesh : sourceMesh;
		if (!geometrySource || typeof geometrySource.getTotalVertices !== "function" || geometrySource.getTotalVertices() <= 0) {
			return null;
		}
		const scene = this.node.getScene?.();
		if (!scene) {
			return null;
		}

		const vertexData = VertexData.ExtractFromMesh(geometrySource, true, true);
		const sourceWorld = sourceMesh.computeWorldMatrix?.(true) ?? geometrySource.computeWorldMatrix?.(true);
		const rootWorld = this.node.computeWorldMatrix?.(true);
		const inverseRootWorld = rootWorld?.clone?.();
		if (!sourceWorld || !inverseRootWorld?.invert) {
			return null;
		}
		inverseRootWorld.invert();
		vertexData.transform(sourceWorld.multiply(inverseRootWorld));

		const batch = new Mesh(`${String(sourceMesh.name ?? "shelf")}_dense_batch_${batchIndex}`, scene);
		batch.parent = this.node;
		batch.material = sourceMesh.material ?? geometrySource.material ?? null;
		batch.metadata = {
			...(sourceMesh.metadata ?? {}),
			generatedByParametricRuntime: true,
			sourceNodeName: sourceMesh.name,
			reason: "shelf_dense_thin_instance_batch",
			denseShelfBatch: true,
			denseShelfSourceName: sourceMesh.name,
			denseShelfThinInstanceCount: entries.length
		};
		batch.doNotSerialize = true;
		batch.isPickable = sourceMesh.isPickable !== false;
		batch.thinInstanceEnablePicking = true;
		vertexData.applyToMesh(batch, true);
		const matrices = new Float32Array(entries.length * 16);
		entries.forEach((entry, index) => {
			const localOffset = this.meterVectorToNodeLocal(this.node, entry.offset);
			Matrix.Translation(localOffset.x, localOffset.y, localOffset.z).copyToArray(matrices, index * 16);
		});
		batch.thinInstanceSetBuffer("matrix", matrices, 16, true);
		// Thin-instance 矩阵不会自动扩大 Mesh 包围盒；强制刷新后，相机、拾取和视觉验收才能看到 100 列/100 层完整空间。
		batch.thinInstanceRefreshBoundingInfo?.(true);
		this.hideDenseSourceMesh(sourceMesh);
		this.generatedNodes.push(batch);
		return batch;
	}

	/** 预先缓存每个 Shelf 部件的可渲染叶 Mesh，避免 100x100 格子循环中重复遍历子树。 */
	private createPartRenderableMeshMap(parts: ShelfPart[]): Map<ShelfPart, any[]> {
		const result = new Map<ShelfPart, any[]>();
		parts.forEach((part) => result.set(part, this.collectRenderableLeafMeshes(part.node)));
		return result;
	}

	/** 收集节点子树内实际参与渲染的叶 Mesh，兼容共享路径中的 InstancedMesh。 */
	private collectRenderableLeafMeshes(node: any): any[] {
		const meshes = typeof node.getChildMeshes === "function" ? node.getChildMeshes(false) : [];
		const candidates = (node?.getTotalVertices?.() > 0 ? [node] : []).concat(meshes);
		return [...new Set(candidates.filter((mesh: any) => (
			mesh && !mesh.isDisposed?.() && mesh.getTotalVertices?.() > 0
		)))];
	}

	/** 隐藏高密度批次已覆盖的原始叶 Mesh；恢复由基础快照统一处理，避免污染同源 Shelf。 */
	private hideDenseSourceMesh(sourceMesh: any): void {
		this.rememberSnapshot(sourceMesh);
		this.denseHiddenNodes.add(sourceMesh);
		sourceMesh.isVisible = false;
		sourceMesh.isPickable = false;
	}

	/** 克隆单个部件并维护全局生成序号。 */
	private clonePartWithIndex(source: any, offset: Vector3, reason: string, cloneIndex: number, clones: any[]): number {
		const clone = this.cloneSingleNode(source, offset, reason, cloneIndex);
		if (clone) {
			clones.push(clone);
			return cloneIndex + 1;
		}
		return cloneIndex;
	}

	/** 生成单元格组合偏移；参数单位为米，方向始终取模型当前局部 X/Y/Z 对应的世界方向。 */
	private createShelfGridOffset(column: number, layer: number, depth: number, spacingX: number, spacingY: number, deepOffsetZ: number, deepOffsetY: number): Vector3 {
		const offset = Vector3.Zero();
		offset.addInPlace(this.createMeterAxisVector("x", column * spacingX));
		offset.addInPlace(this.createMeterAxisVector("y", layer * spacingY + depth * deepOffsetY));
		offset.addInPlace(this.createMeterAxisVector("z", depth * deepOffsetZ));
		return offset;
	}

	/** 判断部件是否进入指定层列深位：后续层只允许上方框架和三角支架，新增列继续复用起始侧支撑。 */
	private shouldClonePartForGridCell(part: ShelfPart, column: number, layer: number, columnLayout: ShelfColumnLayout): boolean {
		if (layer > 0 && !this.isRepeatableLayerPart(part)) {
			return false;
		}
		return column <= 0 || !this.isColumnStartSupportPart(part, columnLayout);
	}

	/** 一次性从全部支撑计算列中心距、起始中心和容差，保证多列复制共享中间立柱。 */
	private createColumnLayout(parts: ShelfPart[], fallback: number): ShelfColumnLayout {
		const supportCenters = parts
			.filter((part) => this.isSupportPart(part))
			.map((part) => this.getNodesMeterAxisBounds([part.node], "x")?.center)
			.filter((center): center is number => typeof center === "number" && Number.isFinite(center));
		const spacing = this.getColumnCenterSpacingFromCenters(supportCenters, fallback);
		return {
			spacing,
			startCenter: supportCenters.length > 0 ? Math.min(...supportCenters) : null,
			tolerance: Math.max(0.01, spacing * 0.05)
		};
	}

	/** 根据全部支撑中心计算列 0 单元宽，失败时退回 cellWidth。 */
	private getColumnCenterSpacingFromCenters(supportCenters: number[], fallback: number): number {
		if (supportCenters.length < 2) {
			return fallback;
		}
		const spacing = Math.abs(Math.max(...supportCenters) - Math.min(...supportCenters));
		return spacing > MIN_DIMENSION ? spacing : fallback;
	}

	/** 判断部件是否处于起始侧支撑线上，新增列会跳过这些节点以形成连续共享立柱。 */
	private isColumnStartSupportPart(part: ShelfPart, columnLayout: ShelfColumnLayout): boolean {
		if (columnLayout.startCenter === null || !this.isSupportPart(part)) {
			return false;
		}
		const center = this.getNodesMeterAxisBounds([part.node], "x")?.center;
		return center !== undefined && Math.abs(center - columnLayout.startCenter) <= columnLayout.tolerance;
	}

	/** 判断节点是否为四根立柱之一。 */
	private isPostPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, POST_NODE_NAMES);
	}

	/** 判断节点是否为四个底脚之一。 */
	private isFootPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, FOOT_NODE_NAMES);
	}

	/** 判断节点是否为立柱或底脚。 */
	private isSupportPart(part: ShelfPart): boolean {
		return this.isPostPart(part) || this.isFootPart(part);
	}

	/** 判断节点是否为贴地深向支撑；该组只属于第一层基座，不随层数复制。 */
	private isBaseDepthSupportPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, BASE_DEPTH_SUPPORT_NODE_NAMES);
	}

	/** 判断节点是否为下方黄色横梁；底腿高度只移动该组，不随层数重复。 */
	private isLowerCrossbeamPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, LOWER_CROSSBEAM_NODE_NAMES);
	}

	/** 判断节点是否为每层顶部的黄色横梁和两侧深向支架。 */
	private isUpperLayerFramePart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, UPPER_LAYER_FRAME_NODE_NAMES);
	}

	/** 判断节点是否为后续层允许重复的上方黄色框架或两侧三角支架。 */
	private isRepeatableLayerPart(part: ShelfPart): boolean {
		return !this.isBaseDepthSupportPart(part) && this.matchesAnyBaseName(part.baseName, REPEATABLE_LAYER_NODE_NAMES);
	}

	/** 判断节点是否为宽度变化时唯一允许沿 X 拉伸的横梁或层板。 */
	private isWidthStretchPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, WIDTH_STRETCH_NODE_NAMES);
	}

	/** 判断节点是否为深度变化时允许沿 Z 拉伸的深度梁或侧撑。 */
	private isDepthStretchPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, DEPTH_STRETCH_NODE_NAMES);
	}

	/** 判断节点是否为侧面三角斜撑，斜撑参与深度拉伸、底腿高度适配和逐层复制。 */
	private isSideTriangleBracePart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, SIDE_TRIANGLE_BRACE_NODE_NAMES);
	}

	/** 收集 Shelf.glb 中可作为参数化部件的父节点，避免直接依赖匿名 mesh 名。 */
	private getShelfParts(): ShelfPart[] {
		const nodes = this.getModelNodes().filter((candidate) => candidate !== this.node && !this.isGeneratedRuntimeClone(candidate));
		const candidates = nodes
			.map((node) => ({ node, baseName: this.getShelfBaseName(node) }))
			.filter((part) => this.matchesAnyBaseName(part.baseName, SHELF_PART_NODE_NAMES) && this.getBoundsMeshes(part.node).length > 0);
		const candidateNodes = new Set(candidates.map((part) => part.node));
		const parts = candidates.filter((part) => !part.node.parent || !candidateNodes.has(part.node.parent));
		return this.dedupePartsByNode(parts);
	}

	/** 去重 Shelf 部件，防止 TransformNode 和 Mesh 同时命中同一个可渲染结构。 */
	private dedupePartsByNode(parts: ShelfPart[]): ShelfPart[] {
		const seen = new Set<any>();
		return parts.filter((part) => {
			if (seen.has(part.node)) {
				return false;
			}
			seen.add(part.node);
			return true;
		});
	}

	/** 获取节点的稳定基础名，兼容父节点名、sourceNodeName 和匿名 node 编号。 */
	private getShelfBaseName(node: any): string {
		const metadataName = String(node?.metadata?.sourceNodeName ?? "");
		const ownName = String(node?.name ?? "");
		const parentName = String(node?.parent?.name ?? "");
		const candidates = [metadataName, ownName, parentName].filter(Boolean);
		for (const candidate of candidates) {
			const cleaned = candidate.replace(/_(?:shelf_layer|shelf_column|double_deep).*$/i, "");
			const direct = SHELF_PART_NODE_NAMES.find((name) => this.matchesBaseName(cleaned, name));
			if (direct) {
				return direct;
			}
		}
		return ownName || parentName;
	}

	/** 判断节点基础名是否匹配任一候选名。 */
	private matchesAnyBaseName(baseName: string, names: string[]): boolean {
		return names.some((name) => this.matchesBaseName(baseName, name));
	}

	/** 判断节点基础名是否匹配指定候选名，兼容 Box023.1 和 node1 这类编号。 */
	private matchesBaseName(baseName: string, name: string): boolean {
		return new RegExp(`^${this.escapeRegExp(name)}(?:\\.|_|$)`, "i").test(baseName);
	}

	/** 转义正则特殊字符，保证节点名按字面量匹配。 */
	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/** 将节点在实体根米空间的指定轴缩放并居中到目标包围盒。 */
	private fitNodeMeterAxisToBounds(target: any, meterAxis: "x" | "y" | "z", localScaleAxis: "x" | "y" | "z", targetBounds: AxisBounds): void {
		if (!target.scaling || !target.position) {
			return;
		}
		const nodeBounds = this.getNodesMeterAxisBounds([target], meterAxis);
		if (!nodeBounds || nodeBounds.size <= MIN_DIMENSION) {
			return;
		}

		const snapshot = this.rememberSnapshot(target);
		const scaleFactor = targetBounds.size / nodeBounds.size;
		if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
			return;
		}
		target.scaling[localScaleAxis] = snapshot.scaling[localScaleAxis] * scaleFactor;
		const fittedBounds = this.getNodesMeterAxisBounds([target], meterAxis);
		if (fittedBounds) {
			this.moveNodeMeterAxisBy(target, meterAxis, targetBounds.center - fittedBounds.center);
		}
	}

	/** 按实体根米空间轴移动节点，写入前转换为父节点本地位移。 */
	private moveNodeMeterAxisBy(target: any, meterAxis: "x" | "y" | "z", meterDelta: number): void {
		if (!target.position || !Number.isFinite(meterDelta) || Math.abs(meterDelta) <= MIN_DIMENSION) {
			return;
		}
		const localDelta = this.meterVectorToParentLocal(target, this.createMeterAxisVector(meterAxis, meterDelta));
		if (typeof target.position.addInPlace === "function") {
			target.position.addInPlace(localDelta);
			return;
		}
		if (typeof target.position.add === "function") {
			target.position = target.position.add(localDelta);
		}
	}

	/** 创建实体根米空间指定轴上的位移向量。 */
	private createMeterAxisVector(axis: "x" | "y" | "z", value: number): Vector3 {
		return this.createLocalAxis(axis).scale(value);
	}

	/** 返回实体根米空间的参数轴。 */
	private getParametricMeterAxis(axis: "x" | "y" | "z"): Vector3 {
		return this.createLocalAxis(axis);
	}

	/** 创建模型局部参数轴单位向量。 */
	private createLocalAxis(axis: "x" | "y" | "z"): Vector3 {
		if (axis === "x") {
			return new Vector3(1, 0, 0);
		}
		if (axis === "y") {
			return new Vector3(0, 1, 0);
		}
		return new Vector3(0, 0, 1);
	}

	/** 将实体根米空间位移转换到目标父节点本地坐标。 */
	private meterVectorToParentLocal(target: any, meterVector: Vector3): Vector3 {
		const entityRoot = this.node.parent;
		const targetParent = target?.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const targetParentWorldMatrix = targetParent?.computeWorldMatrix?.(true) ?? targetParent?.getWorldMatrix?.();
		const inverseTargetParentWorldMatrix = targetParentWorldMatrix?.clone?.();
		if (!entityRootWorldMatrix || !inverseTargetParentWorldMatrix?.invert) {
			return meterVector.clone?.() ?? meterVector;
		}
		inverseTargetParentWorldMatrix.invert();
		const worldVector = Vector3.TransformNormal(meterVector, entityRootWorldMatrix);
		return Vector3.TransformNormal(worldVector, inverseTargetParentWorldMatrix);
	}

	/** 将实体根米空间位移转换到指定节点本地坐标，供 high-density thin instance 矩阵使用。 */
	private meterVectorToNodeLocal(parentNode: any, meterVector: Vector3): Vector3 {
		return this.meterVectorToParentLocal({ parent: parentNode }, meterVector);
	}

	/** 克隆单个节点并应用偏移，克隆失败时直接跳过。 */
	private cloneSingleNode(source: any, offset: Vector3, reason: string, index: number): any | null {
		if (typeof source.clone !== "function") {
			return null;
		}
		const snapshot = this.rememberSnapshot(source);
		const clone = source.clone(`${String(source.name ?? "node")}_${reason}_${index}`, source.parent, false);
		if (!clone) {
			return null;
		}

		const sourcePosition = source.position?.clone?.() ?? snapshot.position.clone();
		const sourceScaling = source.scaling?.clone?.() ?? snapshot.scaling.clone();
		if (clone.position) {
			clone.position = sourcePosition.add(this.meterVectorToParentLocal(source, offset));
		}
		if (clone.scaling) {
			clone.scaling = sourceScaling;
		}
		clone.metadata = { ...(clone.metadata ?? {}), generatedByParametricRuntime: true, sourceNodeName: source.name, reason };
		clone.doNotSerialize = true;
		if (typeof clone.setEnabled === "function") {
			clone.setEnabled(true);
		}
		this.generatedNodes.push(clone);
		return clone;
	}

	/** 清理本脚本生成的所有克隆节点。 */
	private disposeGeneratedNodes(): void {
		while (this.generatedNodes.length > 0) {
			const generated = this.generatedNodes.pop();
			if (generated && typeof generated.dispose === "function") {
				generated.dispose();
			}
		}
	}

	/** 获取当前模型根节点及其子树内的节点。 */
	private getModelNodes(): any[] {
		const scene = this.node.getScene?.();
		const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
		return [...new Set(nodes.filter((candidate) => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
	}

	/** 判断节点是否为本脚本复制出来的运行态克隆。 */
	private isGeneratedRuntimeClone(node: any): boolean {
		return node?.metadata?.generatedByParametricRuntime === true && (node.metadata.sourceNodeName !== undefined || node.metadata.reason !== undefined);
	}

	/** 合并一组节点和子 mesh 在实体根米空间中的包围盒。 */
	private getNodesMeterBounds(nodes: any[]): { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 } | null {
		const xBounds = this.getNodesMeterAxisBounds(nodes, "x");
		const yBounds = this.getNodesMeterAxisBounds(nodes, "y");
		const zBounds = this.getNodesMeterAxisBounds(nodes, "z");
		if (!xBounds || !yBounds || !zBounds) {
			return null;
		}
		const minimum = new Vector3(xBounds.minimum, yBounds.minimum, zBounds.minimum);
		const maximum = new Vector3(xBounds.maximum, yBounds.maximum, zBounds.maximum);
		const center = minimum.add(maximum).scale(0.5);
		const size = maximum.subtract(minimum);
		return { minimum, maximum, center, size };
	}

	/** 读取一组节点在实体根米空间单轴上的最小值、最大值、中心点和尺寸。 */
	private getNodesMeterAxisBounds(nodes: any[], axis: "x" | "y" | "z"): AxisBounds | null {
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		nodes.forEach((node) => {
			this.getBoundsMeshes(node).forEach((mesh) => {
				const bounds = this.getMeshMeterAxisBounds(mesh, axis);
				if (!bounds) {
					return;
				}
				minimum = Math.min(minimum, bounds.minimum);
				maximum = Math.max(maximum, bounds.maximum);
			});
		});
		if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
			return null;
		}
		const size = Math.max(0, maximum - minimum);
		return { minimum, maximum, center: (minimum + maximum) / 2, size };
	}

	/** 收集可用于包围盒计算的真实 mesh；基线排除生成节点，生成节点自测时允许自身子树参与。 */
	private getBoundsMeshes(target: any): any[] {
		const meshes: any[] = [];
		const includeGenerated = this.isGeneratedParametricNode(target);
		if (this.isBoundsMesh(target, includeGenerated)) {
			meshes.push(target);
		}
		if (typeof target?.getChildMeshes === "function") {
			meshes.push(...target.getChildMeshes(false).filter((child: any) => this.isBoundsMesh(child, includeGenerated)));
		}
		return [...new Set(meshes)];
	}

	/** 判断节点是否为当前参数脚本生成的节点或其后代。 */
	private isGeneratedParametricNode(node: any): boolean {
		let current = node;
		while (current && current !== this.node) {
			if (current.metadata?.generatedByParametricRuntime) { return true; }
			current = current.parent;
		}
		return false;
	}

	/** 判断节点是否为有顶点且符合当前测量上下文的 Babylon mesh。 */
	private isBoundsMesh(node: any, includeGenerated: boolean): boolean {
		return typeof node?.getBoundingInfo === "function"
			&& !node.isDisposed?.()
			&& node.isEnabled?.(false) !== false
			&& node.isVisible !== false
			&& Number(node.visibility ?? 1) > 0
			&& Number(node.getTotalVertices?.() ?? 0) > 0
			&& (includeGenerated || !this.isGeneratedParametricNode(node));
	}

	/** 将单个 mesh 的包围盒角点转换到实体根米空间后读取单轴范围。 */
	private getMeshMeterAxisBounds(mesh: any, axis: "x" | "y" | "z"): AxisBounds | null {
		mesh.refreshBoundingInfo?.();
		mesh.computeWorldMatrix?.(true);
		const corners = Array.isArray(mesh.getBoundingInfo?.().boundingBox?.vectorsWorld)
			? mesh.getBoundingInfo().boundingBox.vectorsWorld
			: [];
		const entityRoot = this.node.parent;
		const entityRootWorldMatrix = entityRoot?.computeWorldMatrix?.(true) ?? entityRoot?.getWorldMatrix?.();
		const inverseEntityRootWorldMatrix = entityRootWorldMatrix?.clone?.();
		if (corners.length === 0 || !inverseEntityRootWorldMatrix?.invert) {
			return null;
		}
		inverseEntityRootWorldMatrix.invert();
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		corners.forEach((corner: Vector3) => {
			const meterPoint = Vector3.TransformCoordinates(corner, inverseEntityRootWorldMatrix);
			const value = meterPoint[axis];
			minimum = Math.min(minimum, value);
			maximum = Math.max(maximum, value);
		});
		if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
			return null;
		}
		const size = Math.max(0, maximum - minimum);
		return { minimum, maximum, center: (minimum + maximum) / 2, size };
	}

	/** 读取数值字段，无法转换时使用默认值。 */
	private readNumber(values: ValueMap, key: string, fallback: number): number {
		const value = Number(values[key]);
		return Number.isFinite(value) ? value : fallback;
	}

	/** 读取正数数值字段，非正数或无效值使用默认值。 */
	private readPositiveNumber(values: ValueMap, key: string, fallback: number): number {
		const value = this.readNumber(values, key, fallback);
		return value > 0 ? value : fallback;
	}

	/** 读取布尔字段，兼容字符串形式的 true/false。 */
	private readBoolean(values: ValueMap, key: string, fallback: boolean): boolean {
		const value = values[key];
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "string") {
			return ["true", "1", "yes", "是", "启用"].includes(value.toLowerCase());
		}
		return fallback;
	}

	/** 生成安全比例，避免除零和非法尺寸污染模型变换。 */
	private createSafeRatio(target: number, baseline: number): number {
		if (!Number.isFinite(target) || !Number.isFinite(baseline) || Math.abs(baseline) <= MIN_DIMENSION) {
			return 1;
		}
		return Math.max(MIN_DIMENSION, target / baseline);
	}

	/** 将数值限制在指定范围内。 */
	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}
}
