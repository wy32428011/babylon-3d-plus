# AGV 产生器与地图数据接口

AGV 产生器位于 POI 库，复用设备产生器的模板实体、MQTT 动态生成、离线超时和产物点击绑定能力，并附加 AGV 地图显示。

## 坐标与显示

- 产生器实体的 `Transform.position` 是地图 `(0,0)`；旋转和实体缩放同样作用于地图。
- 地图是二维 XY 数据。默认地图 X → 场景 +X、地图 Y → 场景 +Z；两个轴均可映射到场景正/负 X、Y、Z，但不能使用同一个基础轴。
- 比例尺单位为“米/地图单位”，默认 `1`，允许范围 `0.001–1000`。修改后立即重建轨迹几何，不改变产生器位置。
- “地图轨迹展示”同时控制业务节点标记和运行路线。地图在编辑态和运行预览中都可显示，但不参与鼠标拾取。
- 地图选择包含两份内置示例和本产生器已导入的地图。

## 导入 NDC8 图纸

在桌面编辑器选中 AGV 产生器，点击「地图上传（DXF）」。编辑器将 DXF 原件复制到工程 `Assets/Cad/`，显示模型空间参考图，并把提取的地图保存到产生器。上传完成时，若产生器仍处于选中状态，视口会聚焦到整张图。重新上传会替换该产生器的底图及路网，撤销会同时还原两者。

- 底图保留受支持的线稿、NDC8 编号文字、图层颜色和点位填充。选择已导入的地图即可显示底图，轨迹开关独立控制运行路线及节点覆盖层。
- 转换从 `Ndc8_Point` 与 `Ndc8_PointID` 读取节点。路线中心线依据首尾端点与节点圆心识别并按 NDC8 原始记录顺序与对应编号配对，兼容带方向箭头、零长度占位或省略无箭头占位的 DXF（含 `POLYLINE` 与 `LWPOLYLINE`），顶点顺序和弯道折线完整保留。箭头、定位标记、站点标注继续显示在底图中。路线中心线数量与编号不一致或出现错位图元时会提示错误。
- 「导出地图 JSON」使用下述第一版契约。DXF 坐标换算成米，保留原 CAD XY 原点，导入时比例尺设为 `1`。图纸和轨迹共用产生器位置、轴映射、缩放及旋转。原图缺少明确双向属性时，JSON 保留路线顶点顺序与独立编号。
- 普通 CAD 图纸可通过工具栏导入为参考图。NDC8 转换依赖原导出记录与图层，常规 CAD 线条无法单独确定 AGV 的业务节点和路径。

## 第一版 JSON 契约

导出的地图使用下列结构。坐标必须是有限数值；节点、轨迹 ID 在同一地图内唯一；轨迹端点必须引用已声明节点。

```json
{
  "schemaVersion": 1,
  "id": "factory-line-1",
  "name": "一号产线 AGV 地图",
  "nodes": [
    { "id": "P01", "name": "取货点", "businessType": "pickup", "x": 0, "y": 0 },
    { "id": "P02", "name": "卸货点", "businessType": "dropoff", "x": 12, "y": 8 }
  ],
  "tracks": [
    {
      "id": "T01",
      "name": "主路线",
      "fromNodeId": "P01",
      "toNodeId": "P02",
      "bidirectional": true,
      "points": [
        { "x": 0, "y": 0 },
        { "x": 12, "y": 0 },
        { "x": 12, "y": 8 }
      ]
    }
  ]
}
```

字段约定：

- `businessType` 是可选业务分类字符串，当前预置示例使用 `pickup`、`dropoff`、`station`、`charging`、`waiting`；渲染不依赖该分类。
- `bidirectional` 是可选业务元数据，本版仅保存，不影响轨迹显示。
- `points` 是可选的完整有序折线，至少两个点，适合 CAD 中的多段线。省略时使用 `fromNodeId`、`toNodeId` 对应业务节点的 XY 坐标绘制直线。
- 当前校验上限为 4096 个业务节点、8192 条轨迹、每条轨迹 2048 个折线点。

类型定义和校验入口位于 `src/editor/model/agvMap.ts`，内置地图注册位于 `src/editor/model/agvMapLibrary.ts`。内置地图随场景保存 ID 与显示配置。DXF 导入地图另随场景保存节点与路线，底图从工程内的 DXF 副本读取。

## AGV MQTT 位姿驱动

设备模型的 `deviceType` 或模型包 `dataDriven.device.devType` 声明为 `agv` 后，模型 Inspector 会显示「数据驱动」。旧场景只有 `modelAsset.deviceType='agv'` 时也会补建默认绑定，不要求重新导入模型。

标准配置流程：拖入 AGV 模型并校准、隐藏模板实例 → 创建 AGV 产生器并关联模板、选择地图和点击事件 → 运行预览接收 MQTT。产生器只在运行态创建动态设备，隐藏模板自身不参与设备驱动。

- 模型包通过 `dataDriven.device.modelForwardAxis` 声明 GLB 局部车头轴默认值；模板的 `telemetryBinding.modelForwardAxis` 可覆盖该默认值，「恢复模型默认绑定」会回到包内声明。可选 `+X`、`-X`、`+Z`、`-Z`，缺省 `+X`，动态实例继承模板最终配置。
- 角度协议约定 `r=0` 时车头指向场景 `+X`，顺时针为正。驱动根据模型正方向轴补偿初始朝向，不把 `movement_x` 当作位移量。
- 动态 AGV 的 `x/y` 是产生器地图坐标：先按产生器的 `xAxis/yAxis/scale` 换算，再应用产生器实体的完整 Transform。地图原点就是产生器位置，比例尺和轴映射与地图显示一致。未关联地图的静态 AGV 仍按场景世界 `X/Z` 驱动。`z=null` 不参与整机移动；只更新一个平面字段时保留另一地图通道。当前不做路网吸附或路径约束。
- `normal=false`、非零 `errorCode`、数据断流或 `mode=0` 时不继续更新位姿；动态实例收到 `mode=0` 后按 AGV 离线协议销毁，也继续兼容通用 `status=offline`。
- 其余 `command`、`deviceType`、`signalBits`、`task`、`containerCode`、`batteryLevel`、`message`、`timestamp`、`task_begin_point`、`task_end_point` 等原始字段保留在标准快照和运行时诊断中。当前不据此生成货物或执行装卸动画。
- AGV 产生器按模板的 `deviceType` 注册，首条带 `s` 的 MQTT 消息生成实例，后续消息按 topic 中的设备号及完整 `sourceId/deviceType/assetCode` 驱动对应实例。动态实例在生成时读取产生器的地图放置配置；当前不消费任务点或路网拓扑。
- 动态 AGV 可点击。点击后右侧显示「动态 AGV 实例」及只读「数据驱动」模块，包含来源产生器、继承配置、在线状态、topic、时间和最新 MQTT fields；产生器配置的高亮、聚焦和图表点击事件继续执行。动态选区和实例快照不写入场景文档，实例下线或退出预览即清理。

可用 `npm run demo:spawn:mqtt` 发布包含上述字段的 AGV 演示数据，或先运行 `node scripts/simulate-device-spawn-mqtt.mjs --once --stdout` 检查报文。领域回归入口为 `npm run test:agv-drive`，产生器与地图回归入口为 `npm run test:agv-spawner`。
