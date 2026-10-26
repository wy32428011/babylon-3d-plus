# Q0 B2 探针 GPU 显存预算与缩批重试

用户要求：先补齐 Q0 的 GPU 风险项，保持画质、样本数、几何、六方向/2×2 采样顺序、脚本与 MQTT 行为；Q0 验收后再推进 Q1。本记录只覆盖 B2，不代表整个 Q0 阶段通过。

验收清单：

- [x] 只在实际 GPU 模式选择自适应批次；CPU 保持 1024² / 4816 容量配置和原输出。
- [x] 按可核验的选中设备空闲显存选择保守初始图像/容量；查询不可用时有明确原因及保守策略，不伪造显存值。
- [x] 仅 GPU OOM 同时缩小图像缓冲与批次，重做尚未提交的当前批次；最低布局仍 OOM 才发送既有整任务 CPU 回退标记。
- [x] 非 OOM 不缩批；旧服务已识别的 GPU 设备故障保留整任务 CPU 回退标记，普通错误、CPU OOM 与取消原样失败。失败批次没有新增/覆盖探针输出；恢复第二遍烘焙临时隐藏的灯光，清理图像、对象、网格与材质。
- [x] 保持六面顺序、每面 4×4 与四周 1 像素、中心 2×2 的 dx/dy 顺序，位置/探针顺序不变。
- [x] 实际设备、内存来源、初始计划、每次尺寸/容量/起点/数量、实际 bake 次数、OOM 原因与重试次数进入现有日志及任务报告。
- [x] 独立复核的分类/marker 修复后，11 路径与修改前脚本标记对照通过；最终交付脚本真实 CPU 4096 探针/1024² 图集对照通过，源码/交付 SHA256 相同。
- [ ] 真实独立 GPU 上的显存不足、恢复与峰值尚未实测：本机 Cycles 只发现 CPU，不能把注入通过称作真实 GPU 验收。

实现边界与策略：

- `electron/lighting-bake/cycles_bake.py` 保留默认 CPU。NVIDIA CUDA/OPTIX 使用系统已有 `nvidia-smi --query-gpu=uuid,pci.bus_id,name,memory.total,memory.free --format=csv,noheader,nounits`，不新增依赖、不运行 shell、不改设备偏好，查询超时 2 秒；先匹配 Cycles 选中设备的 UUID/PCI（域补零按数值比较），无 PCI 时才接受唯一的精确名称。多张同名卡无法唯一匹配时拒绝猜测。查询字段及格式依据 [NVIDIA 官方 nvidia-smi 文档](https://docs.nvidia.com/deploy/nvidia-smi/index.html)。
- 按真实 `freeBytes` 先预留 512 MiB，再取剩余的 1/16 作为图像预算，以 64 bytes/像素保守估计两份 float32 ndarray、Blender 图像和设备副本。该预算不是整场景显存峰值保证；几何、纹理、驱动或竞争进程仍可能导致 OOM，因此保留缩批及最终 CPU 回退。示例注入：空闲 8 GiB→1024²；1 GiB→512²；32 MiB→128²。
- AMD HIP、Intel ONEAPI、Apple METAL，及查询缺失/超时/错误/非数值/设备不能唯一对应时，`freeBytes`/`totalBytes` 保持 `null`，保守从 256² 开始。允许继续把现有 `PROBE_IMAGE_SIZE` / `PROBE_BATCH_SIZE` 调低；CPU 既有可配置行为保持。
- GPU 常规容量：1024²/4816 → 512²/1204 → 256²/294 → 128²/64；按实际图像容量及配置上限取小值。只有确认 OOM 才进入下一级，每次都重新创建较小图像与目标网格，不仅减少对象数量。128²/64 是原安全布局下限，仍 OOM 才发一次 `LIGHTING_BAKE_GPU_FALLBACK`，原主进程重启独立 CPU 整任务的路径无需改动。
- 探针内部 OOM 重试期间不发最终回退标记；`CUDA illegal address`、`device lost`、无效分配大小与无效 UV 等不被判成可缩批内存错误。旧 `is_gpu_memory_error` 已识别的设备故障仍立即发原标记并走整任务 CPU 回退；普通错误、CPU OOM 和取消不发。图集原有设备失败/CPU 回退分类保持不变。第二遍失败时恢复原 `hide_render`，而非把原本隐藏的灯光强制打开。
- 每次尝试开始输出 `LIGHTING_BAKE_PROBE_BATCH`，退出（成功/失败/可捕获取消）输出 `LIGHTING_BAKE_PROBE_BATCHES` 完整报告，并写入任务暂存根的 `probe-batches.json`。已有服务将协议外行保留到 `cycles.log`；即使整任务 CPU 回退覆盖 JSON，原 GPU 日志仍保留。操作系统强杀不能保证 Python finally 执行，外部取消/清理继续由现有服务负责。
- `probes.json` 只在所有探针成功之后写入；各批结果先留内存，失败当前批重做，已成功批次不重复追加。失败诊断 JSON 写入遇到 `OSError` 仅记录，不遮蔽原始 OOM/取消；成功后诊断写入失败仍报错。

测试先于实现：

- 新增 `tests/lightingBake/cycles_probe_gpu_checks.py`，缺少显存查询/自适应入口时先得到 RED（`red.log`），再实现并得到 GREEN。
- 预算覆盖选中 PCI、多张同名卡、不可对应设备、N/A、超时、进程失败、缺少工具、非 NVIDIA 后端、非法显存计数；测试 1024/512/256/128 四级容量及严格 OOM 分类。
- 用实际 Blender 对象、UV、材质与图像数据块，仅替换 bake 操作注入错误。初版覆盖第二遍 OOM 后重试、前一批已成功后后续批 OOM、最低仍 OOM、非 OOM、`KeyboardInterrupt`、CPU OOM 共 6 条路径。每次实际记录图像尺寸，验证 UV/法线/瓦片布局，失败前后四类数据块数量相同；验证位置与数值不重复/丢失。GPU 成功重试共 6 次 bake，最低失败发一次最终标记。
- 根代理独立源码复核后，新增无效 argument/value/allocation size、分配非内存 handle 等严格 OOM 分类负例，以及设备丢失/无效设备/普通错误路径。共 11 路径，支持 `--legacy-script` 对照本次修改前脚本的真实 `bake_diffuse` 标记合同，确保设备故障保留原回退、普通错误与取消不回退。按根代理要求先写测试再修复，CPU profile 期间暂停运行；profile 结束后先在旧交付脚本分别复现两条 RED，再复制新脚本取得 GREEN。证据为 `strict-red.log`（无效参数被误当OOM）、`marker-red.log`（旧CUDA错误回退标记丢失）、`strict-delivered-injection/report.json`（11路径及修改前脚本对照全部通过）。此前6路径报告仅保留历史，不作为最终版本证据。
- 注入使用真实 Blender 数据块但未执行 GPU Cycles，不证明独显驱动能够从真实 OOM 中恢复。主进程实际外部取消仍由根代理的既有 Cycles 集成入口覆盖。

验证结果（均针对实际交付脚本）：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 实际设备发现 | 仅 CPU；CUEW/HIPEW 库初始化不可用 | `strict-delivered-injection.log`、`strict-delivered-injection/report.json` |
| GPU 预算及失败注入 | 最终11路径及旧标记合同对照通过；失败不覆盖旧输出，临时数据块数不变 | `strict-delivered-injection/report.json` |
| CPU 完整几何/UV/采样合同 | 4096 单批/2 次 bake；可配置 64、旧 128²、小批1和0探针通过 | `strict-cpu-contract/report.json` |
| 真实 CPU 七表面 1024² 图集 | 与本次修改前 B1+B2 脚本相比，4,194,304 PNG 分量差 0 | `strict-delivered-cpu-comparison/report.json` |
| 真实 CPU 4096 探针 | 前后均2次 bake；73,728 个值差0；位置顺序相同 | 同上 `probes.comparison` |
| Python 入口合同 | `node --test tests/lightingBake/lightingBakePythonContracts.test.mjs`，4/4通过 | 终端记录 |
| 语法与限定 diff | `py_compile` 与 `git diff --check` 通过 | 终端记录 |

环境：Windows，`C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`，Blender `5.2.2 LTS`（d13f752e3b9c）、NumPy `2.3.4`。真实 CPU 对照固定 seed `20261024`、关闭动画 seed 与去噪、8 次总反弹/4 次漫反射；图集16 samples、探针128 samples，与上一轮夹具一致。最终单次 CPU 对照耗时约 6.70→7.49 秒，非独立性能基准，不据此宣称加速；本次目的为 CPU 数值回归和 GPU 内存错误处理。

相对证据均位于 `output/render-optimization-b2-gpu/`。修改前副本为 `baseline_cycles_bake.py`（SHA256 `c88604c0d3290a535cefaa3b971a81c6e4512f86fed03d185c283dd198876c20`）；最终 `strict-sha256.json` 记录源/交付 SHA256 均为 `2810faf1ceef84543da3d64dac8ee830e2f7e9a3803bd22c44e0b22213390a51`。同步仅执行现有构建机制所做的受控脚本复制，没有运行全局构建。根代理后续统一构建与入口登记。

复现命令：

```powershell
$engine = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python electron/lighting-bake/cycles_bake.py -- --devices
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_probe_gpu_checks.py -- --bake-script dist-electron/lighting-bake/cycles_bake.py --legacy-script output/render-optimization-b2-gpu/baseline_cycles_bake.py --output output/render-optimization-b2-gpu/strict-delivered-injection
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_probe_batch_checks.py -- --bake-script dist-electron/lighting-bake/cycles_bake.py --output output/render-optimization-b2-gpu/strict-cpu-contract
& $engine --background --factory-startup --disable-autoexec --python-exit-code 1 --python tests/lightingBake/cycles_q0_bake_checks.py -- --baseline-script output/render-optimization-b2-gpu/baseline_cycles_bake.py --bake-script dist-electron/lighting-bake/cycles_bake.py --stage combined --probe-count 4096 --output output/render-optimization-b2-gpu/strict-delivered-cpu-comparison
```

审查：已按 `python-reviewer` / `code-reviewer` 检查本次限定改动。没有增加外部输入执行、shell 调用、用户偏好写入或默认值修改；错误原样传播，资源释放在 finally。`ruff` 未安装，未安装依赖。没有改动 MQTT/业务脚本/运行时渲染、服务层、全局入口清单或根实施记录；未提交、推送、发布、生成安装器或启动常驻资源。

## 根集成最终状态

- 用户明确答复“暂时没有，先完成本地实现与回归”；真实独显恢复/显存峰值继续留作未验证，不以注入代替。
- 共享Cycles入口已登记cycles_probe_gpu_checks.py，最终 `node tests/lightingBake/cycles.integration.mjs` exit0；日志 `output/render-optimization-b2-gpu/cycles-integration-final.log`，含实际交付Python的GPU预算/失败注入、真实CPU生成、UV/图集完整性及取消/超时/旧资源保护。
- 根回退所有无收益L2实验后重新完成TypeScript/Editor/Viewer build、lint和test:entries，源/交付Python仍同SHA2810faf1ceef84543da3d64dac8ee830e2f7e9a3803bd22c44e0b22213390a51。B2本地完成不代表L2/Q0通过；Q1尚未进入。
