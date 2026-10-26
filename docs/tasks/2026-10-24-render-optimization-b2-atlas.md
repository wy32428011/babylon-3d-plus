# Q1 B2 图集合批：两轮无收益，已完整撤回

状态：功能候选已实验验证，但未满足实际耗时下降。依据原方案第439行“同项连续两次没有可复现收益时停止，保留原实现”，已撤回全部 B2atlas 产品改动及默认测试路径，继续使用已通过 B6/Q0 的原串行图集流程。本项不能记作已取得优化收益。

## 不变约束与候选实现

以 B6 Python `802b5ab70a04d8c0fa4d6d79bf9425ca331cd490e3f903a8fb6c9e7ff3da8f86` 独立冻结为基准，未改几何、材质内容、图集分辨率/装箱/UV页索引、seed、samples、反弹或 RGBM 算法。候选在512MiB可控浮点预算内合并多个页面：每页材质副本使用对象级slots，独立目标图像；完整间接/环境两遍成功并释放临时图像/材质后，才逐页编码保存。

预算没有照抄“512MiB可8张2048²”：每页按 float图像16B/px + 第一遍ndarray16B/px + 设备副本16B/px，再加一份共享第二遍scratch16B/px。保存发生在图像释放后，单独计结果数组、编码数组及float64乘数/分母中间量；批次总估计由烘焙阶段上界覆盖。2048²实际最多2页，4096²最低单页可能已超该额外合批预算，仍保留原尺寸单页，不降低画质。此预算仅为可控缓冲估计，不承诺总RSS或GPU显存峰值。

GPU预算不可核验时保守单页；OOM仅缩页数到1，不缩图。最低仍失败、已知非OOM设备失败按既有marker整任务CPU回退；普通错误、CPU OOM、取消不被掩盖。GPU路径本轮只有真实Blender数据块上的失败注入，不能当成硬件GPU执行证据。

红见证：`target-red.log` 复现直接把旧attach_target套入多页时，共享材质使第0页指向最后第2页；`cleanup-red.log` 复现不完整finally留下3张临时图。这两条是**不安全合批思路**的否决见证，不是声称原串行产品存在共享目标污染。第一候选的 `functional-green/report.json` 通过共享材质、第二遍失败清理、灯光/slots恢复及6类失败注入。第一次计时后的小页串行fallback仅进入第二候选，第二候选没有重复完整GPU注入，且最终未进入产品。

## 实际 CPU 结果

两轮都先协调 root/其它agent 停止所有本任务构建、测试、Electron、浏览器和broker；计时期间仅此Blender进程执行，其他agent只做文本/日志读取。每轮先完整 A/B warmup，再 A1/B1/B2/A2，不删除异常或挑样。夹具为24个有色receiver，生产装箱算法，CPU，Blender5.2.2 LTS，固定seed20261024、16samples、无动画seed/去噪、8次总反弹/4次漫反射。

统计范围为**图集bake+像素合并+RGBM编码+写盘**，包含副本/分派/清理开销；UV/装箱准备与v2导出分别记录，不混入该阶段。不是完整工程加载、整任务启动或现场FPS结论。

| 输入 | 顺序/阶段 | 基线ms | 候选ms | 结果 |
| --- | --- | ---: | ---: | --- |
| 256²，48px/m，3页 | warmup | 1472.720 | 1566.923 | 保留冷暖样本 |
| 同上 | A1/B1 | 1335.275 | 1669.607 | 候选更慢 |
| 同上 | A2/B2 | 1367.623 | 1619.304 | 候选更慢 |
| 同上 | 正式均值 | 1351.449 | 1644.456 | **+21.681%** |
| 2048²，256px/m，2页 | warmup | 55490.879 | 57384.218 | 保留冷暖样本 |
| 同上 | A1/B1 | 54904.777 | 56731.731 | 候选更慢 |
| 同上 | A2/B2 | 55271.979 | 55533.570 | 候选更慢 |
| 同上 | 正式均值 | 55088.378 | 56132.650 | **+1.896%** |

第一轮 bpy operator 由6降为2，但性能负收益。第二候选据此令小于1024的小页直接走原单页执行器，避免用更大输入掩盖小页退化；第二轮用实际可选的2048尺寸验证大页边界，bpy operator由4降为2，实际 `cycles.engine.bake` 逐对象调用却始终是48次。第二轮每个 warm/formal run 均保留native计数。

分段证据显示主要代价在native bake内：第一轮A1六次native包裹的operator合计约1283.90ms（全阶段1335.27ms），B1两次合计约1598.27ms（全阶段1669.61ms）；Python副本/读写等外层差异不能解释主要退化。本机 owning source `Blender 5.2/5.2/scripts/addons_core/cycles/engine.py:115-119`、`cycles/__init__.py:82-83` 使用逐对象obj调用 `_cycles.bake`。减少 bpy operator 次数不能据此推出减少实际Cycles工作；本次没有测量或伪称BVH实际构建次数。

等价性两轮均通过且**未放松1LSB标准**：

- 256三页每轮786432个PNG分量比较，最大差0；2048两页每轮33554432个PNG分量比较，最大差0。
- 每个正式run都与冻结warm-baseline逐页比较；RGBM范围、页序/尺寸、全部UV与页索引相同。
- 每个对象B6 v2 geometry逐文件SHA完全相同，未重排角点、属性或材质映射。
- 临时Blender图像/材质/对象/网格前后计数一致，原灯光恢复。
- RSS记录为同一进程生命周期峰值，后续run包含之前峰值，**不能当作独立A/B峰值或GPU显存比较**。

## 撤回与复核位置

全部位于 `output/render-optimization-q1-20261024/b2-atlas/`：

- `b6-baseline-cycles_bake.py`：本项独立基准。
- `timed-1/`：第一候选完整warmup/ABBA、PNG、v2几何、run.json、report.json；当时源码另存 `candidate-cycles_bake.py` 与SHA。
- `timed-2-2048/`：第二候选全部warmup/ABBA、native计数、PNG、v2几何、run.json、report.json。
- `rejected-candidate/repo/`：完整第二候选Python、两个实验夹具及原输入fixture，保持小型独立目录结构可显式复现；`rejected-candidate/sha256.json` 记录归档与恢复SHA。实验夹具已移出项目 tests 树，不登记为默认产品测试。

当前 `electron/lighting-bake/cycles_bake.py` 和 `dist-electron/lighting-bake/cycles_bake.py` 均已**逐字节恢复**上述 B6 SHA `802b5ab70a04d8c0fa4d6d79bf9425ca331cd490e3f903a8fb6c9e7ff3da8f86`，因此 Q0 GPU 与 B6 保留；未修改任何 shared合同、reader、package/入口清单、B3或其它产品文件。既有B6独立审查和相关验证仍适用于恢复后的相同文件。root已收到撤回与安静窗口结束通知，可统一构建。

若未来明确重开研究，应先证明更低层native工作减少或另一个具体热点，不能因为operator计数好看重新启用当前候选。本次不追加第三轮、不操控Cycles私有状态、不对未实测独显收益做推断；未提交、推送或发布。
