# 发布时光照 UV 失败修复

## 目标与范围

- 用户报告发布时 `lighting-bake:start` 返回 `Object-10 有正面积三角面未获得有效光照 UV`，授权调查、修复与验证。
- 入场已有光照综合优化的大量未提交改动和另一项完整工厂 UV 扫描；保留已有内容，不干预该扫描、不提交推送、不外部发布。
- 复用已有共线面判断与细面 UV 修复，只补本次证据、实际交付脚本回归和构建同步；后续仅按真实失败证据调整范围。

## 验收清单

- [x] 用真实 Blender 和当前交付脚本复现用户原文错误。
- [x] 明确源码、构建脚本与发布 IPC 的执行关系。
- [x] 实际交付脚本通过共线面与正面积细面回归，保留全部三角面、源属性和目标采样密度；破坏真实正面积面 UV 仍拒绝。
- [x] 常规 Cycles 集成入口覆盖交付脚本，真实生成/取消/超时/预算与图集回归通过。
- [x] Electron 构建同步修复，核对交付脚本 SHA256；相关静态检查和独立代码审查完成。
- [x] 记录结论、使用方式与无法证明的现场边界。

## 证据与决定

- `output/lighting-uv-publish-fix/delivered-red.log`：真实 Blender 5.2.2 读取旧 `dist-electron/lighting-bake/cycles_bake.py`，四面夹具直接报 `Object-10 有正面积三角面未获得有效光照 UV`。
- `output/lighting-uv-publish-fix/baseline.log`：入场源码的相同回归通过，共线夹具 4/4 面、细面夹具 31/31 面，最低密度均不低于 4 px/m，严格 UV 拒绝保留。
- 入场源码 SHA256 `31674a5de7568a31db932a622776b0a06bcc04280a63b04828a46f69bdc933ef`，交付副本 SHA256 `6eb51ebd6ec36c63836f949dce653b24150ebb9bcc708e78b0761976c291f57b`。交付副本未包含已有 `LightmapUvError` / `repair_lightmap_uvs` 修复。
- 现有 Electron 构建会复制 Python 脚本；无需另写一套修复或放松 UV 校验。新回归明确选择 `dist-electron` 作为被测模块。

## 完成与验证

- `npm run build:electron`、`npm run typecheck` 均退出 0；源码与交付脚本最终 SHA256 均为上面的 `31674a...33ef`，本次没有重写入场已有生产 Python 算法。
- 更新后的 `node tests/lightingBake/cycles.integration.mjs` 退出 0，真实 Blender 5.2.2 CPU 完成 UV、图集和探针生成、取消、超时、提交取消、预算拒绝、外部链接拒绝，以及逐面图集和跨页密度检查。主报告和日志位于 `output/lighting-uv-publish-fix/cycles-integration.log`，完整引擎证据在该报告的 `evidenceDirectory`。
- 新 UV 回归先在旧交付脚本上失败（`regression-red.log`），更新后通过（`delivered-uv-report.json`）：共线面 4/4 保留、细面 31/31 保留，独立最低采样分别为 4.0003995 和 4.0004072 px/m，目标为 4。
- 首次全链检查发现已有提交取消断言只匹配中文字符串，而当前原生 `fs.readFile({ signal })` 返回标准 `AbortError` / `ABORT_ERR`。独立原生调用复现后仅修正测试错误谓词，仍严格检查正式资产目录不变。原失败日志保留为 `cycles-integration-first-failure.log`，未修改生产取消语义。
- 定向构建输出/后台/Python 合同测试 21 项全部通过；ESLint、Node 语法、Python AST、测试入口清单检查、`git diff --check` 通过；独立通用与 Python 代码审查无阻断项。
- 复用并核对本次期间完成的完整工厂 UV 扫描：`output/lighting-optimization/uv-repro-1792732550388-vpooSk/final-full-uv-VNnB7W/report.json` 为 success，821 源 / 870875 原始三角面经过空间切分为 1602 输出网格 / 1128217 三角面，42 张图集，目标 4 px/m。扫描使用的生产源码与本次最终 SHA 一致；这里只完成 UV 准备和打包，不能视作完整工厂 Cycles 或发布成功。
- 本机没有找到用户此次 Object-10 的原始失败任务输入，不能把同类夹具和旧工厂 Object-43/127 当作该业务场景本身。未操作用户原工程、未对外发布、未重打安装包、未验证已安装版本；本地开发产物可启动新任务验证，安装版需要包含修复的新安装包。
