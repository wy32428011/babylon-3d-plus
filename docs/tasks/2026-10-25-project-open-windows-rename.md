# 2026-10-25 中台工程打开 Windows rename EPERM 修复

目标：修复截图所示 `extracted/Assets → materialize/staged/Assets` 的一次性占用失败，以及首次失败留下空目录后无法重试的问题，并保留远端 SOURCE、现有工作区和事务恢复语义。

## 验收清单

- [x] 定位：工程打开物化、推广、回滚直接调用 `fs.rename`；已有资源同步对 Windows `EPERM/EACCES/EBUSY` 有退避保护，此处遗漏。
- [x] 实现：四处移动统一使用局部重试函数，沿用既有七档延时，最多八次调用；普通错误立即抛出，保留零复制移动。
- [x] 取消：暂存与推广等待可取消；回滚不传取消 signal，保证恢复动作继续执行。
- [x] 真实 Electron 入口注入暂时/持续占用与普通错误，核对新项目打开、旧内容保留、推广失败回滚、取消恢复及不完整回滚恢复目录。
- [x] 首次失败后的完整/部分空骨架可重试；文件、未知空目录及实际 Windows junction 仍拒绝且预检只读。已有 currentProjectMetadata 首次 503 后再打开回归恢复通过。
- [x] `npm run typecheck`、`npm run build:electron`、两个源文件的 ESLint 通过；五个定向测试文件 32/32 通过，0 跳过。
- [x] README、任务日志、经验记录和最终 diff 复核。
- [ ] 原报错项目的真实桌面重启/打开验收：用户选择“先交付修复，我稍后重启”，本次明确延后。

边界：只修改编辑器工程打开及定向测试/文档，不修改中台后端、下载协议、远端版本和用户工程内容；保留已有未提交优化改动，不提交、推送或发布。

证据：截图报错发生在本地解压后的物化阶段；中台 `package/export` 只返回 SOURCE 文件流。Windows 占用来源尚未抓取，不能断言具体安全软件或进程。

## 验证结果与交接

- 最终测试：`node --experimental-strip-types --test tests/dataPlatform/workspaceProjectOpen.test.ts tests/dataPlatform/projectPackageSizeLimit.test.ts tests/dataPlatform/currentProjectMetadata.test.ts tests/dataPlatform/projectSessionClose.test.ts tests/dataPlatform/dataPlatformProjectLocation.test.ts`，32 passed、0 failed、0 skipped，约 62.4 秒。完整日志：`output/project-open-windows-rename-20261025/focused-tests.log`。锁错误通过隔离 Electron 进程中的 fs.rename 注入，实际文件与事务使用真实临时工作区；没有声称已抓取外部占用进程。
- 原项目 `2071816469849280514` 的工作目录实际仅有初始化空目录，无场景/资产文件；用构建后的 resolver 只读预检已返回截图同一来源目录。证据：`output/project-open-windows-rename-20261025/actual-project-preflight.json`。这仅证明目录预检可通过，不等于工程已打开。
- 旧桌面进程 PID `90420` 尚运行旧主进程代码。常规关闭未生效，目标 `Stop-Process` 返回“拒绝访问”；未提升权限，也未启动另一份应用绕过单实例保护。用户在了解到原窗口/PID仍存在后明确选择稍后重启，保留原实例与服务。
- 后续操作：退出当前 ZENDING 3D EDITOR 后，在仓库运行 `npm run dev:electron`，从首页打开原项目；若仍有持续占用，保留实际 errno/恢复目录进一步排查。本次无后端修改、提交、推送或发布。
