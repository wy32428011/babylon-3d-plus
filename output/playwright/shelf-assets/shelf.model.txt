// 此文件由模型包参数脚本和运行脚本合并而成，供编辑器以单个 TS 文件读取。
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { visibleAsBoolean, visibleAsNumber, visibleAsString } from "babylonjs-editor-tools";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

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
	public description: string = "Shelf.glb 专用参数化：层数沿 Y 复制，宽度仅拉伸 node1/node3/node25/node35 对应横梁和层板并保留端部搭接量，四根立柱和连接件跟随这些节点的宽深新端点移动，侧面三角斜撑随深度和层高同步适配。";

	@visibleAsNumber("层数", { step: 1 })
	public layerCount: number = 1;

	@visibleAsNumber("列数", { step: 1 })
	public columnCount: number = 1;

	@visibleAsNumber("货格宽度", { step: 0.1 })
	public cellWidth: number = 0.801;

	@visibleAsNumber("货格高度", { step: 0.1 })
	public cellHeight: number = 4.525;

	@visibleAsNumber("货格深度", { step: 0.1 })
	public cellDepth: number = 1.183;

	@visibleAsNumber("立柱宽度", { step: 0.01 })
	public postWidth: number = 0.08;

	@visibleAsNumber("巷道宽度", { step: 0.1 })
	public aisleWidth: number = 1.2;

	@visibleAsNumber("巷道高度", { step: 0.1 })
	public aisleHeight: number = 1;

	@visibleAsBoolean("启用双深货位")
	public doubleDeepEnabled: boolean = false;

	@visibleAsNumber("深位间隔", { step: 0.05 })
	public deepSlotGap: number = 0.2;

	@visibleAsNumber("深位提升", { step: 0.05 })
	public deepSlotLift: number = 0;

	@visibleAsString("货架样式")
	public shelfStyle: string = "beam";

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

const DEFAULT_VALUES: ValueMap = {
	modelKey: "shelf",
	deviceType: "多穿库",
	deviceName: "多穿货架",
	description: "Shelf.glb 专用参数化：层数沿 Y 复制，宽度仅拉伸 node1/node3/node25/node35 对应横梁和层板并保留端部搭接量，四根立柱和连接件跟随这些节点的宽深新端点移动，侧面三角斜撑随深度和层高同步适配。",
	layerCount: 1,
	columnCount: 1,
	cellWidth: 0.801,
	cellHeight: 4.525,
	cellDepth: 1.183,
	postWidth: 0.08,
	aisleWidth: 1.2,
	aisleHeight: 1,
	doubleDeepEnabled: false,
	deepSlotGap: 0.2,
	deepSlotLift: 0,
	shelfStyle: "beam"
};

const POST_NODE_NAMES = ["Box004", "Box001", "Box002", "Box003", "node5", "node7", "node9", "node11"];
const FOOT_NODE_NAMES = ["Jiao001", "Jiao002", "Jiao003", "Jiao004", "node27", "node29", "node31", "node33"];
const WIDTH_STRETCH_NODE_NAMES = ["Box023", "Box021", "Box032", "Box031", "node1", "node3", "node25", "node35"];
const ENDPOINT_ANCHOR_NODE_NAMES = WIDTH_STRETCH_NODE_NAMES;
const SIDE_TRIANGLE_BRACE_NODE_NAMES = ["Box008", "Box007", "node15", "node21"];
const DEPTH_BEAM_NODE_NAMES = ["Box020", "Box005", "Box006", "Box022", "node13", "node17", "node19", "node23"];
const DEPTH_STRETCH_NODE_NAMES = DEPTH_BEAM_NODE_NAMES;
const SHELF_PART_NODE_NAMES = [
	...POST_NODE_NAMES,
	...FOOT_NODE_NAMES,
	...WIDTH_STRETCH_NODE_NAMES,
	...DEPTH_STRETCH_NODE_NAMES,
	...SIDE_TRIANGLE_BRACE_NODE_NAMES
];

const MIN_DIMENSION = 0.001;
const MAX_LAYER_COUNT = 20;
const MAX_COLUMN_COUNT = 100;
const MAX_GENERATED_NODES = 5000;
const MAX_TRIANGLE_BRACE_MODULES_PER_LAYER = 20;

/** 根据 Inspector 参数对 Shelf.glb 执行部件级静态参数化调整。 */
export class ParametricModelRuntimeComponent {
	private readonly snapshots = new Map<any, NodeSnapshot>();
	private readonly generatedNodes: any[] = [];
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
				enabled: typeof target.isEnabled === "function" ? target.isEnabled() : undefined
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
			if (snapshot.enabled !== undefined && typeof target.setEnabled === "function") {
				target.setEnabled(snapshot.enabled);
			}
		});
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
			cellDepth: this.readNumber({ cellDepth: this.readRuntimeValue("cellDepth", mergedValues.cellDepth) }, "cellDepth", Number(DEFAULT_VALUES.cellDepth)),
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

	/** 读取 Shelf 部件并按宽、高、深、层数和列数生成目标形态。 */
	private applyShelfParameters(values: ValueMap): void {
		const parts = this.getShelfParts();
		const bounds = this.getNodesWorldBounds(parts.map((part) => part.node));
		if (!bounds || parts.length === 0) {
			return;
		}

		const targetWidth = this.readPositiveNumber(values, "cellWidth", bounds.size.x);
		const targetLayerHeight = this.readPositiveNumber(values, "cellHeight", bounds.size.y);
		const targetDepth = this.readPositiveNumber(values, "cellDepth", bounds.size.z);
		const layers = this.clamp(Math.round(this.readNumber(values, "layerCount", 1)), 1, MAX_LAYER_COUNT);
		const columns = this.clamp(Math.round(this.readNumber(values, "columnCount", 1)), 1, MAX_COLUMN_COUNT);
		const heightRatio = this.createSafeRatio(targetLayerHeight, bounds.size.y);
		const triangleBraceModuleCount = this.getTriangleBraceModuleCount(targetLayerHeight, bounds.size.y);
		const triangleBraceModuleHeight = targetLayerHeight / triangleBraceModuleCount;
		const triangleBraceHeightRatio = this.createSafeRatio(triangleBraceModuleHeight, bounds.size.y);

		this.applySingleLayerDimensions(parts, bounds, targetWidth, targetDepth, heightRatio, triangleBraceHeightRatio);
		this.applyPostTotalHeight(parts, bounds, targetLayerHeight * layers);
		const columnSpacing = this.getColumnCenterSpacing(parts, targetWidth);
		this.cloneShelfGrid(parts, values, layers, columns, targetLayerHeight, columnSpacing, targetDepth, triangleBraceModuleCount, triangleBraceModuleHeight);
	}

	/** 对原始一层 Shelf 应用宽度、高度和深度的基础变形。 */
	private applySingleLayerDimensions(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetWidth: number, targetDepth: number, heightRatio: number, triangleBraceHeightRatio: number): void {
		this.applyShelfWidthLayout(parts, bounds, targetWidth);
		this.applyShelfDepthLayout(parts, bounds, targetDepth);

		parts.filter((part) => this.isLayerPart(part)).forEach((part) => {
			const nodeBounds = this.getNodesWorldAxisBounds([part.node], "y");
			if (nodeBounds && part.node.position) {
				if (this.isSideTriangleBracePart(part)) {
					this.fitNodeWorldAxisToBounds(part.node, "y", "z", this.createHeightScaledBounds(nodeBounds, bounds.minimum.y, triangleBraceHeightRatio));
				} else {
					this.moveNodeWorldAxisBy(part.node, "y", bounds.minimum.y + (nodeBounds.center - bounds.minimum.y) * heightRatio - nodeBounds.center);
				}
			}
		});
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
		const nodeBounds = this.getNodesWorldAxisBounds([part.node], "x");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeWorldAxisToBounds(part.node, "x", "x", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 非跨宽连接件保持相对最近端点的原始偏移，随跨宽节点端点一起外移或内收。 */
	private moveConnectedPartWithWidthEndpoint(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesWorldAxisBounds([part.node], "x");
		if (!nodeBounds || !part.node.position) {
			return;
		}
		this.moveNodeWorldAxisBy(part.node, "x", this.getEndpointConnectedCenter(nodeBounds, layout) - nodeBounds.center);
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
		const nodeBounds = this.getNodesWorldAxisBounds([part.node], "z");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeWorldAxisToBounds(part.node, "z", "y", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 侧面三角斜撑独立适配深度端点，避免与普通水平深度梁混用分类。 */
	private applySideTriangleBraceDepthPart(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesWorldAxisBounds([part.node], "z");
		if (!nodeBounds) {
			return;
		}

		this.fitNodeWorldAxisToBounds(part.node, "z", "y", this.createEndpointAnchoredBounds(nodeBounds, layout));
	}

	/** 非深度拉伸部件保持相对最近前后端点的原始偏移，随新深度边界移动。 */
	private moveConnectedPartWithDepthEndpoint(part: ShelfPart, layout: ShelfAxisLayout): void {
		const nodeBounds = this.getNodesWorldAxisBounds([part.node], "z");
		if (!nodeBounds || !part.node.position) {
			return;
		}
		this.moveNodeWorldAxisBy(part.node, "z", this.getEndpointConnectedCenter(nodeBounds, layout) - nodeBounds.center);
	}

	/** 计算通用端点布局，保留跨宽节点之外的固定外沿余量。 */
	private createShelfAxisLayout(nodes: any[], axis: "x" | "z", bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, targetSize: number): ShelfAxisLayout {
		const source = this.getNodesWorldAxisBounds(nodes, axis) ?? {
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

	/** 侧面三角斜撑需要端点随层高变化，不能只移动中心，否则多层后斜撑会落在错误高度。 */
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

	/** 将四根立柱从底部固定点拉高到层数对应的总高度。 */
	private applyPostTotalHeight(parts: ShelfPart[], bounds: { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 }, totalHeight: number): void {
		const targetMaximum = bounds.minimum.y + Math.max(MIN_DIMENSION, totalHeight);
		const targetBounds: AxisBounds = {
			minimum: bounds.minimum.y,
			maximum: targetMaximum,
			center: (bounds.minimum.y + targetMaximum) / 2,
			size: Math.max(MIN_DIMENSION, targetMaximum - bounds.minimum.y)
		};
		parts.filter((part) => this.isPostPart(part)).forEach((part) => this.fitNodeWorldAxisToBounds(part.node, "y", "z", targetBounds));
	}

	/** 按层、列、深位的一次性组合偏移复制 Shelf，避免把运行态克隆再次当作语义源。 */
	private cloneShelfGrid(parts: ShelfPart[], values: ValueMap, layers: number, columns: number, spacingY: number, spacingX: number, targetDepth: number, triangleBraceModuleCount: number, triangleBraceModuleHeight: number): any[] {
		const clones: any[] = [];
		const depthCount = this.readBoolean(values, "doubleDeepEnabled", false) ? 2 : 1;
		const deepOffsetZ = targetDepth + this.readNumber(values, "deepSlotGap", 0);
		const deepOffsetY = this.readNumber(values, "deepSlotLift", 0);
		const startSupportCenter = this.getColumnStartSupportCenter(parts);
		let cloneIndex = 1;

		for (let depth = 0; depth < depthCount; depth += 1) {
			for (let column = 0; column < columns; column += 1) {
				for (let layer = 0; layer < layers; layer += 1) {
					const offset = this.createShelfGridOffset(column, layer, depth, spacingX, spacingY, deepOffsetZ, deepOffsetY);
					parts.forEach((part) => {
						if (this.generatedNodes.length >= MAX_GENERATED_NODES || !this.shouldClonePartForGridCell(part, column, layer, startSupportCenter)) {
							return;
						}
						if (this.isSideTriangleBracePart(part)) {
							cloneIndex = this.cloneTriangleBraceModules(part, offset, depth, column, layer, triangleBraceModuleCount, triangleBraceModuleHeight, cloneIndex, clones);
							return;
						}
						if (depth === 0 && column === 0 && layer === 0) {
							return;
						}
						cloneIndex = this.clonePartWithIndex(part.node, offset, `shelf_grid_d${depth}_c${column}_l${layer}`, cloneIndex, clones);
					});
				}
			}
		}
		return clones;
	}

	/** 计算每层三角支架模块数量，层高成倍增加时同步增加支架数量而不是只拉长单个支架。 */
	private getTriangleBraceModuleCount(targetLayerHeight: number, sourceLayerHeight: number): number {
		const ratio = sourceLayerHeight > MIN_DIMENSION ? targetLayerHeight / sourceLayerHeight : 1;
		// 支架模块高度不应超过原始层高；只要目标层高超过基准层高，就向上取整增加一组支架。
		const moduleCount = ratio <= 1 + MIN_DIMENSION ? 1 : Math.ceil(ratio - MIN_DIMENSION);
		return this.clamp(moduleCount, 1, MAX_TRIANGLE_BRACE_MODULES_PER_LAYER);
	}

	/** 在单个货格内复制侧面三角支架模块；原始第一个模块保留，其余模块按层内高度间距补齐。 */
	private cloneTriangleBraceModules(part: ShelfPart, baseOffset: Vector3, depth: number, column: number, layer: number, moduleCount: number, moduleHeight: number, cloneIndex: number, clones: any[]): number {
		let nextIndex = cloneIndex;
		for (let module = 0; module < moduleCount; module += 1) {
			if (depth === 0 && column === 0 && layer === 0 && module === 0) {
				continue;
			}
			if (this.generatedNodes.length >= MAX_GENERATED_NODES) {
				return nextIndex;
			}
			const moduleOffset = baseOffset.add(this.createWorldAxisVector("y", module * moduleHeight));
			nextIndex = this.clonePartWithIndex(part.node, moduleOffset, `shelf_brace_d${depth}_c${column}_l${layer}_m${module}`, nextIndex, clones);
		}
		return nextIndex;
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
		offset.addInPlace(this.createWorldAxisVector("x", column * spacingX));
		offset.addInPlace(this.createWorldAxisVector("y", layer * spacingY + depth * deepOffsetY));
		offset.addInPlace(this.createWorldAxisVector("z", depth * deepOffsetZ));
		return offset;
	}

	/** 判断某个原始部件是否应该出现在指定层列深位中，新增层不复制立柱/底脚，新增列复用起始侧支撑。 */
	private shouldClonePartForGridCell(part: ShelfPart, column: number, layer: number, startSupportCenter: number | null): boolean {
		if (layer > 0 && !this.isLayerPart(part)) {
			return false;
		}
		return column <= 0 || !this.isColumnStartSupportPart(part, startSupportCenter);
	}

	/** 读取左右支撑中心距作为多列 0 间距语义，失败时回退到 cellWidth。 */
	private getColumnCenterSpacing(parts: ShelfPart[], fallback: number): number {
		const supportCenters = parts
			.filter((part) => this.isSupportPart(part))
			.map((part) => this.getNodesWorldAxisBounds([part.node], "x")?.center)
			.filter((center): center is number => typeof center === "number" && Number.isFinite(center));
		if (supportCenters.length < 2) {
			return fallback;
		}
		const spacing = Math.abs(Math.max(...supportCenters) - Math.min(...supportCenters));
		return spacing > MIN_DIMENSION ? spacing : fallback;
	}

	/** 获取起始侧支撑中心，用于新增列共享上一列边界立柱和底脚。 */
	private getColumnStartSupportCenter(parts: ShelfPart[]): number | null {
		const supportCenters = parts
			.filter((part) => this.isSupportPart(part))
			.map((part) => this.getNodesWorldAxisBounds([part.node], "x")?.center)
			.filter((center): center is number => typeof center === "number" && Number.isFinite(center));
		return supportCenters.length > 0 ? Math.min(...supportCenters) : null;
	}

	/** 判断部件是否处于起始侧支撑线上，新增列会跳过这些节点以形成连续共享立柱。 */
	private isColumnStartSupportPart(part: ShelfPart, startSupportCenter: number | null): boolean {
		if (startSupportCenter === null || !this.isSupportPart(part)) {
			return false;
		}
		const center = this.getNodesWorldAxisBounds([part.node], "x")?.center;
		const spacing = this.getColumnCenterSpacing([part], 0);
		const tolerance = Math.max(0.01, spacing * 0.05);
		return center !== undefined && Math.abs(center - startSupportCenter) <= tolerance;
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

	/** 判断节点是否为需要参与层复制的横梁、深度梁、层板或斜撑。 */
	private isLayerPart(part: ShelfPart): boolean {
		return !this.isPostPart(part) && !this.isFootPart(part);
	}

	/** 判断节点是否为宽度变化时唯一允许沿 X 拉伸的横梁或层板。 */
	private isWidthStretchPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, WIDTH_STRETCH_NODE_NAMES);
	}

	/** 判断节点是否为深度变化时允许沿 Z 拉伸的深度梁或侧撑。 */
	private isDepthStretchPart(part: ShelfPart): boolean {
		return this.matchesAnyBaseName(part.baseName, DEPTH_STRETCH_NODE_NAMES);
	}

	/** 判断节点是否为侧面三角斜撑，斜撑同时参与深度拉伸和层高端点适配。 */
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

	/** 将节点指定世界轴缩放并居中到目标包围盒。 */
	private fitNodeWorldAxisToBounds(target: any, worldAxis: "x" | "y" | "z", localScaleAxis: "x" | "y" | "z", targetBounds: AxisBounds): void {
		if (!target.scaling || !target.position) {
			return;
		}
		const nodeBounds = this.getNodesWorldAxisBounds([target], worldAxis);
		if (!nodeBounds || nodeBounds.size <= MIN_DIMENSION) {
			return;
		}

		const snapshot = this.rememberSnapshot(target);
		const scaleFactor = targetBounds.size / nodeBounds.size;
		if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
			return;
		}
		target.scaling[localScaleAxis] = snapshot.scaling[localScaleAxis] * scaleFactor;
		const fittedBounds = this.getNodesWorldAxisBounds([target], worldAxis);
		if (fittedBounds) {
			this.moveNodeWorldAxisBy(target, worldAxis, targetBounds.center - fittedBounds.center);
		}
	}

	/** 按模型参数轴移动节点，写入前转换为父节点本地位移，兼容 GLB __root__ 坐标转换。 */
	private moveNodeWorldAxisBy(target: any, worldAxis: "x" | "y" | "z", worldDelta: number): void {
		if (!target.position || !Number.isFinite(worldDelta) || Math.abs(worldDelta) <= MIN_DIMENSION) {
			return;
		}
		const localDelta = this.worldVectorToParentLocal(target, this.createWorldAxisVector(worldAxis, worldDelta));
		if (typeof target.position.addInPlace === "function") {
			target.position.addInPlace(localDelta);
			return;
		}
		if (typeof target.position.add === "function") {
			target.position = target.position.add(localDelta);
		}
	}

	/** 生成指定模型参数轴上的世界位移向量，保证模型旋转后仍沿自身 X/Y/Z 变形。 */
	private createWorldAxisVector(axis: "x" | "y" | "z", value: number): Vector3 {
		return this.getParametricWorldAxis(axis).scale(value);
	}

	/** 读取模型根节点当前局部轴对应的世界方向，忽略缩放长度只保留方向。 */
	private getParametricWorldAxis(axis: "x" | "y" | "z"): Vector3 {
		const localAxis = this.createLocalAxis(axis);
		const worldMatrix = this.node.computeWorldMatrix?.(true) ?? this.node.getWorldMatrix?.();
		const worldAxis = worldMatrix ? Vector3.TransformNormal(localAxis, worldMatrix) : localAxis;
		return this.normalizeDirection(worldAxis, localAxis);
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

	/** 将方向向量归一化，零长度或异常值时使用兜底方向。 */
	private normalizeDirection(direction: Vector3, fallback: Vector3): Vector3 {
		const length = direction.length?.() ?? 0;
		if (!Number.isFinite(length) || length <= 0.000001) {
			return fallback.clone?.() ?? fallback;
		}
		return direction.scale(1 / length);
	}

	/** 将世界位移向量转换到目标父节点本地坐标，避免直接写 position 造成方向反转。 */
	private worldVectorToParentLocal(target: any, worldVector: Vector3): Vector3 {
		const parent = target?.parent;
		if (!parent || typeof parent.getWorldMatrix !== "function") {
			return worldVector.clone?.() ?? worldVector;
		}
		parent.computeWorldMatrix?.(true);
		const parentMatrix = parent.getWorldMatrix?.();
		if (!parentMatrix || typeof parentMatrix.clone !== "function") {
			return worldVector.clone?.() ?? worldVector;
		}
		const inverseParentMatrix = parentMatrix.clone();
		inverseParentMatrix.invert?.();
		return Vector3.TransformNormal(worldVector, inverseParentMatrix);
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
			clone.position = sourcePosition.add(this.worldVectorToParentLocal(source, offset));
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

	/** 合并一组节点和子 mesh 在模型参数轴上的投影包围盒。 */
	private getNodesWorldBounds(nodes: any[]): { minimum: Vector3; maximum: Vector3; center: Vector3; size: Vector3 } | null {
		const xBounds = this.getNodesWorldAxisBounds(nodes, "x");
		const yBounds = this.getNodesWorldAxisBounds(nodes, "y");
		const zBounds = this.getNodesWorldAxisBounds(nodes, "z");
		if (!xBounds || !yBounds || !zBounds) {
			return null;
		}
		const minimum = new Vector3(xBounds.minimum, yBounds.minimum, zBounds.minimum);
		const maximum = new Vector3(xBounds.maximum, yBounds.maximum, zBounds.maximum);
		const center = minimum.add(maximum).scale(0.5);
		const size = maximum.subtract(minimum);
		return { minimum, maximum, center, size };
	}

	/** 读取一组节点当前包围盒在模型参数轴投影上的最小值、最大值、中心点和尺寸。 */
	private getNodesWorldAxisBounds(nodes: any[], axis: "x" | "y" | "z"): AxisBounds | null {
		const axisDirection = this.getParametricWorldAxis(axis);
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		nodes.forEach((node) => {
			this.getBoundsMeshes(node).forEach((mesh) => {
				const bounds = this.getMeshProjectedBounds(mesh, axisDirection);
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

	/** 收集可用于包围盒计算的真实 mesh。 */
	private getBoundsMeshes(target: any): any[] {
		const meshes: any[] = [];
		if (this.isBoundsMesh(target)) {
			meshes.push(target);
		}
		if (typeof target?.getChildMeshes === "function") {
			meshes.push(...target.getChildMeshes(false).filter((child: any) => this.isBoundsMesh(child)));
		}
		return [...new Set(meshes)];
	}

	/** 判断节点是否可以提供 Babylon 世界包围盒。 */
	private isBoundsMesh(node: any): boolean {
		return typeof node?.getBoundingInfo === "function" && !node.metadata?.generatedByParametricRuntime;
	}

	/** 获取单个 mesh 沿指定模型参数轴的世界投影范围。 */
	private getMeshProjectedBounds(mesh: any, axisDirection: Vector3): AxisBounds | null {
		mesh.computeWorldMatrix?.(true);
		mesh.refreshBoundingInfo?.();
		const box = mesh.getBoundingInfo?.().boundingBox;
		const corners = Array.isArray(box?.vectorsWorld) ? box.vectorsWorld : [];
		if (corners.length === 0) {
			return null;
		}
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		corners.forEach((corner: Vector3) => {
			const value = Vector3.Dot(corner, axisDirection);
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
