# AGV 产生器与地图数据接口

AGV 产生器位于 POI 库，复用设备产生器的模板实体、MQTT 动态生成、离线超时和产物点击绑定能力，并附加 AGV 地图显示。

## 坐标与显示

- 产生器实体的 `Transform.position` 是地图 `(0,0)`；旋转和实体缩放同样作用于地图。
- 地图是二维 XY 数据。默认地图 X → 场景 +X、地图 Y → 场景 +Z；两个轴均可映射到场景正/负 X、Y、Z，但不能使用同一个基础轴。
- 比例尺单位为“米/地图单位”，默认 `1`，允许范围 `0.001–1000`。修改后立即重建轨迹几何，不改变产生器位置。
- “地图轨迹展示”同时控制业务节点标记和运行路线。地图在编辑态和运行预览中都可显示，但不参与鼠标拾取。
- 本版提供两份内置示例地图。地图上传按钮仅作功能预留；CAD 上传与转换尚未实现。

## 第一版 JSON 契约

CAD 转换模块后续应输出下列结构。坐标必须是有限数值；节点、轨迹 ID 在同一地图内唯一；轨迹端点必须引用已声明节点。

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

类型定义和校验入口位于 `src/editor/model/agvMap.ts`，内置地图注册位于 `src/editor/model/agvMapLibrary.ts`。场景只保存地图 ID 与显示配置，不复制整份地图数据。
