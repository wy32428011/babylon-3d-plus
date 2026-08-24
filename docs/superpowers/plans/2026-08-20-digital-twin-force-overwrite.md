# Digital Twin Force Overwrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在数字孪生编辑器中增加单次强制覆盖发布，使落后的本地版本可基于数据中台当前最新版本创建下一版本，同时保留资源修订校验和上传期间并发保护。

**Architecture:** 编辑器通过新增的 `forceOverwrite` 布尔字段显式传递用户意图；数据中台 prepare 阶段解析出任务实际基线并保存到现有 `base_version_id`，无需数据库迁移。commit 继续对任务基线执行 compare-and-swap，因此强制覆盖只处理发布开始前已经存在的版本分叉，不处理 prepare 后的新并发版本。

**Tech Stack:** React 19、TypeScript 6、Electron IPC、Node.js test runner、Java 17、Spring Boot 3、JUnit 5、Mockito、Maven

---

## 文件结构

### 数据中台仓库 `C:\projects\CentralDataPlatform`

- `backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/dto/DigitalTwinPublishPrepareDTO.java`：接收并归一化 `forceOverwrite`。
- `backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishValidator.java`：根据远端最新版本、本地基线和两个覆盖开关解析任务实际基线。
- `backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppService.java`：使用实际基线创建发布任务。
- `backend/twin-module-editor/src/test/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishValidatorTest.java`：覆盖版本解析规则。
- `backend/twin-module-editor/src/test/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppServiceTest.java`：验证强制覆盖任务保存远端最新基线。

### 编辑器仓库 `C:\temp\babylon-3d-plus`

- `electron/types.ts`、`src/vite-env.d.ts`：扩展 IPC 请求契约。
- `electron/ipc/digitalTwinUploadClient.ts`：扩展 prepare API 请求和响应基线校验。
- `electron/ipc/digitalTwinPublishService.ts`：允许显式强制覆盖越过预发布版本冲突，并把意图传到数据中台。
- `src/editor/deployment/useDigitalTwinPublish.ts`：从 UI 向 IPC 传递 `forceOverwrite`。
- `src/editor/deployment/DigitalTwinPublishDialog.tsx`：展示高风险确认项并调整提交校验。
- `tests/digitalTwin/digitalTwinPublish.integration.mjs`：覆盖普通冲突、强制覆盖成功、资源冲突和 commit 并发冲突。
- `README.md`：更新用户可见发布行为。

---

### Task 1: 数据中台解析强制覆盖基线

**Files:**
- Modify: `C:\projects\CentralDataPlatform\backend\twin-module-editor\src\test\java\com\centraldataplatform\twin\editor\app\service\DigitalTwinPublishValidatorTest.java`
- Modify: `C:\projects\CentralDataPlatform\backend\twin-module-editor\src\main\java\com\centraldataplatform\twin\editor\app\service\DigitalTwinPublishValidator.java`

- [ ] **Step 1: 写失败测试，定义强制覆盖与普通发布的基线规则**

将现有 `validateVersion` 测试改为调用返回 `Long` 的 `resolveBaseVersion`，并新增：

```java
@Test
void shouldRebaseStaleEditorVersionWhenForceOverwriteIsConfirmed() {
    assertEquals(201L, DigitalTwinPublishValidator.resolveBaseVersion(201L, 200L, true, true));
}

@Test
void shouldStillRejectStaleEditorVersionWithoutForceOverwrite() {
    BizException exception = assertThrows(
            BizException.class,
            () -> DigitalTwinPublishValidator.resolveBaseVersion(201L, 200L, true, false)
    );
    assertEquals("DIGITAL_TWIN_VERSION_CONFLICT", exception.getCode());
}

@Test
void shouldUseLatestVersionForExplicitFirstOverwrite() {
    assertEquals(200L, DigitalTwinPublishValidator.resolveBaseVersion(200L, null, true, false));
}
```

- [ ] **Step 2: 运行测试确认因方法不存在而失败**

Run:

```powershell
mvn -q -pl twin-module-editor -am -Dtest=DigitalTwinPublishValidatorTest -Dsurefire.failIfNoSpecifiedTests=false test -f backend/pom.xml
```

Expected: `DigitalTwinPublishValidator.resolveBaseVersion` 编译失败或相关断言失败。

- [ ] **Step 3: 实现最小基线解析逻辑**

在 `DigitalTwinPublishValidator` 中用以下方法替代 `validateVersion`：

```java
public static Long resolveBaseVersion(Long latestVersionId,
                                      Long baseVersionId,
                                      boolean overwriteExisting,
                                      boolean forceOverwrite) {
    if (latestVersionId == null) {
        return null;
    }
    if (baseVersionId == null) {
        if (!overwriteExisting) {
            throw new BizException(
                    "DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED",
                    "目标项目已经存在数字孪生工程，请确认覆盖后重试"
            );
        }
        return latestVersionId;
    }
    if (!latestVersionId.equals(baseVersionId)) {
        if (!forceOverwrite) {
            throw new BizException(
                    "DIGITAL_TWIN_VERSION_CONFLICT",
                    "远端数字孪生工程已经产生新版本，请重新打开最新工程后再发布"
            );
        }
        return latestVersionId;
    }
    return baseVersionId;
}
```

保留 `validateCommitVersion` 和 `validateResourceRevision` 原有严格行为。

- [ ] **Step 4: 运行 validator 测试确认通过**

Run: 与 Step 2 相同。

Expected: `DigitalTwinPublishValidatorTest` 全部 PASS。

- [ ] **Step 5: 提交数据中台 validator 变更**

```powershell
git -C C:\projects\CentralDataPlatform add backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishValidator.java backend/twin-module-editor/src/test/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishValidatorTest.java
git -C C:\projects\CentralDataPlatform commit -m "feat: resolve digital twin force overwrite base"
```

---

### Task 2: 数据中台 prepare 接收强制覆盖并保存实际基线

**Files:**
- Modify: `C:\projects\CentralDataPlatform\backend\twin-module-editor\src\test\java\com\centraldataplatform\twin\editor\app\service\DigitalTwinPublishAppServiceTest.java`
- Modify: `C:\projects\CentralDataPlatform\backend\twin-module-editor\src\main\java\com\centraldataplatform\twin\editor\app\dto\DigitalTwinPublishPrepareDTO.java`
- Modify: `C:\projects\CentralDataPlatform\backend\twin-module-editor\src\main\java\com\centraldataplatform\twin\editor\app\service\DigitalTwinPublishAppService.java`

- [ ] **Step 1: 写失败测试，验证任务采用远端最新版本作为基线**

给测试 request helper 增加 `forceOverwrite` 参数，并新增：

```java
@Test
void prepareShouldUseRemoteLatestVersionAsBaseWhenForceOverwriteIsConfirmed() {
    TestContext context = context();
    DigitalTwinProjectBindingDO binding = new DigitalTwinProjectBindingDO();
    binding.setProjectId(1L);
    binding.setEditorProjectId(8L);
    binding.setLatestVersionId(11L);
    when(context.bindingMapper.selectById(1L)).thenReturn(binding);
    when(context.projectAppService.get(1L)).thenReturn(project());
    when(context.revisionService.captureRevision(1L)).thenReturn(3L);
    when(context.taskMapper.insert(any(DigitalTwinPublishTaskDO.class))).thenReturn(1);
    when(context.taskMapper.updateById(any(DigitalTwinPublishTaskDO.class))).thenReturn(1);
    when(context.uploadService.createSession(any(), eq("SOURCE"), any())).thenAnswer(invocation -> upload(100L, "SOURCE"));
    when(context.uploadService.createSession(any(), eq("DIST"), any())).thenAnswer(invocation -> upload(101L, "DIST"));
    stubUploadVo(context);

    context.service.prepare(request(true, true, false, 9L, List.of()));

    verify(context.taskMapper).insert(argThat(task -> Long.valueOf(11L).equals(task.getBaseVersionId())));
}
```

- [ ] **Step 2: 运行 service 测试确认失败**

```powershell
mvn -q -pl twin-module-editor -am -Dtest=DigitalTwinPublishAppServiceTest -Dsurefire.failIfNoSpecifiedTests=false test -f backend/pom.xml
```

Expected: DTO 构造参数或任务基线断言失败。

- [ ] **Step 3: 扩展 DTO 并在 service 中保存实际基线**

在 `overwriteExisting` 后新增字段并归一化：

```java
Boolean forceOverwrite,
```

```java
forceOverwrite = Boolean.TRUE.equals(forceOverwrite);
```

prepare 中先解析基线：

```java
Long resolvedBaseVersionId = DigitalTwinPublishValidator.resolveBaseVersion(
        latestVersionId,
        request.baseVersionId(),
        Boolean.TRUE.equals(request.overwriteExisting()),
        Boolean.TRUE.equals(request.forceOverwrite())
);
```

创建任务时直接使用：

```java
task.setBaseVersionId(resolvedBaseVersionId);
```

不新增数据库字段；现有 `base_version_id` 即为 commit 使用的实际 compare-and-swap 基线。

- [ ] **Step 4: 运行 editor 模块两组定向测试**

```powershell
mvn -q -pl twin-module-editor -am -Dtest=DigitalTwinPublishValidatorTest,DigitalTwinPublishAppServiceTest -Dsurefire.failIfNoSpecifiedTests=false test -f backend/pom.xml
```

Expected: 两个测试类全部 PASS。

- [ ] **Step 5: 提交数据中台 prepare 变更**

```powershell
git -C C:\projects\CentralDataPlatform add backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/dto/DigitalTwinPublishPrepareDTO.java backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppService.java backend/twin-module-editor/src/test/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppServiceTest.java
git -C C:\projects\CentralDataPlatform commit -m "feat: accept digital twin force overwrite"
```

---

### Task 3: 编辑器发布契约传递 `forceOverwrite`

**Files:**
- Modify: `C:\temp\babylon-3d-plus\tests\digitalTwin\digitalTwinPublish.integration.mjs`
- Modify: `C:\temp\babylon-3d-plus\electron\types.ts`
- Modify: `C:\temp\babylon-3d-plus\src\vite-env.d.ts`
- Modify: `C:\temp\babylon-3d-plus\electron\ipc\digitalTwinUploadClient.ts`
- Modify: `C:\temp\babylon-3d-plus\electron\ipc\digitalTwinPublishService.ts`
- Modify: `C:\temp\babylon-3d-plus\src\editor\deployment\useDigitalTwinPublish.ts`

- [ ] **Step 1: 写失败集成测试，定义强制覆盖请求与继续发布行为**

在 `createPublishRequest` 默认值中增加：

```javascript
forceOverwrite: false,
```

保留现有未强制版本冲突断言，并新增强制覆盖场景：

```javascript
await resetBinding();
mock.setRemoteStatus(createRemoteStatus({ latestVersionId: NEW_VERSION_ID, latestVersionNumber: 2 }));
mock.resetRequests();
const forcedResult = await publishModule.publishDigitalTwin(
  createPublishRequest('force-version-overwrite', sceneContent, { forceOverwrite: true }),
  new AbortController().signal,
  () => undefined,
);
assert.equal(forcedResult.status, 'completed');
const forcedPrepare = mock.requests.find((request) => (
  request.path.endsWith('/publish-tasks/prepare') && request.body.requestId === 'force-version-overwrite'
));
assert.ok(forcedPrepare);
assert.equal(forcedPrepare.body.forceOverwrite, true);
assert.equal(forcedPrepare.body.baseVersionId, BASE_VERSION_ID);
const forcedTask = [...mock.tasks.values()].find((record) => record.task.requestId === 'force-version-overwrite');
assert.equal(forcedTask.task.baseVersionId, NEW_VERSION_ID);
```

普通成功请求追加断言：

```javascript
assert.equal(successPrepare.body.forceOverwrite, false);
```

- [ ] **Step 2: 构建 Electron 并运行集成测试确认失败**

```powershell
npm run test:digital-twin:integration
```

Expected: 强制覆盖仍返回 `conflict`，或 prepare 请求缺少 `forceOverwrite`。

- [ ] **Step 3: 扩展 TypeScript 与 IPC 请求类型**

在以下请求类型中加入必填布尔字段：

```typescript
forceOverwrite: boolean;
```

涉及 `DigitalTwinPublishRequest`、`StartDigitalTwinPublishOptions` 和 `DigitalTwinPreparePayload`。`useDigitalTwinPublish.start` 调用 IPC 时原样传递该字段。

- [ ] **Step 4: 修改发布服务只在未确认时拦截版本冲突**

请求归一化增加：

```typescript
forceOverwrite: request.forceOverwrite === true,
```

运行配置与本地冲突包判断改为：

```typescript
if (!context.versionConflict || validated.forceOverwrite) {
  // 保存现有运行配置
}
```

```typescript
if (context.versionConflict && !validated.forceOverwrite) {
  // 保留现有 conflict copy 返回
}
```

prepare 请求增加：

```typescript
baseVersionId: current.metadata.latestVersionId,
forceOverwrite: validated.forceOverwrite,
```

集成 mock 的 prepare 响应在 `forceOverwrite=true` 时使用 `this.remoteStatus.latestVersionId` 作为任务基线，以模拟数据中台服务端重建基线。`assertPreparedPublishTask` 在 `forceOverwrite=false` 时继续严格匹配请求基线；强制覆盖时要求服务端返回非空任务基线，并允许它与请求中的落后基线不同。commit 身份校验继续锁定 prepare 响应中的任务基线。

- [ ] **Step 5: 运行编辑器发布集成测试确认通过**

```powershell
npm run test:digital-twin:integration
```

Expected: 原有发布场景和新增强制覆盖场景全部 PASS。

- [ ] **Step 6: 提交编辑器协议和服务变更**

```powershell
git add electron/types.ts src/vite-env.d.ts electron/ipc/digitalTwinUploadClient.ts electron/ipc/digitalTwinPublishService.ts src/editor/deployment/useDigitalTwinPublish.ts tests/digitalTwin/digitalTwinPublish.integration.mjs
git commit -m "feat: publish local digital twin with force overwrite"
```

---

### Task 4: 发布弹窗增加单次高风险确认

**Files:**
- Create: `C:\temp\babylon-3d-plus\src\editor\deployment\digitalTwinForceOverwrite.ts`
- Create: `C:\temp\babylon-3d-plus\tests\digitalTwin\digitalTwinForceOverwrite.test.ts`
- Modify: `C:\temp\babylon-3d-plus\src\editor\deployment\DigitalTwinPublishDialog.tsx`

- [ ] **Step 1: 写失败单元测试，定义冲突提交校验**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDigitalTwinForceOverwrite } from '../../src/editor/deployment/digitalTwinForceOverwrite.ts';

test('版本冲突未确认强制覆盖时返回校验错误', () => {
  assert.equal(
    validateDigitalTwinForceOverwrite(true, false),
    '远端已经产生新版本，请确认强制使用本地版本覆盖后再发布。',
  );
});

test('版本冲突已确认或没有冲突时允许继续', () => {
  assert.equal(validateDigitalTwinForceOverwrite(true, true), null);
  assert.equal(validateDigitalTwinForceOverwrite(false, false), null);
});
```

- [ ] **Step 2: 运行测试确认模块不存在**

```powershell
node --experimental-strip-types --test tests/digitalTwin/digitalTwinForceOverwrite.test.ts
```

Expected: FAIL，无法导入 `digitalTwinForceOverwrite.ts`。

- [ ] **Step 3: 实现纯校验函数**

```typescript
export function validateDigitalTwinForceOverwrite(
  versionConflict: boolean,
  forceOverwrite: boolean,
): string | null {
  return versionConflict && !forceOverwrite
    ? '远端已经产生新版本，请确认强制使用本地版本覆盖后再发布。'
    : null;
}
```

- [ ] **Step 4: 在弹窗接入确认状态与交互**

增加：

```typescript
const [forceOverwrite, setForceOverwrite] = useState(false);
```

切换项目、关闭弹窗以及新上下文进入时重置为 `false`。提交时调用纯校验函数并把 `forceOverwrite` 传给 controller。

版本冲突提示改为高风险说明，并在发布设置中展示：

```tsx
{context?.versionConflict ? (
  <label className="digital-twin-publish-confirmation digital-twin-publish-confirmation-warning">
    <input
      checked={forceOverwrite}
      disabled={isBusy}
      onChange={(event) => {
        setForceOverwrite(event.target.checked);
        setValidationError(null);
      }}
      type="checkbox"
    />
    <span>
      <strong>强制使用本地版本覆盖远端最新版本</strong>
      <small>本地内容将创建为下一版本，历史版本保留；项目资源修订仍会严格校验。</small>
    </span>
  </label>
) : null}
```

提交按钮不再因 `context.versionConflict` 永久禁用，按钮文案在冲突时显示“确认强制覆盖并发布”。

- [ ] **Step 5: 运行单元测试和 typecheck**

```powershell
node --experimental-strip-types --test tests/digitalTwin/digitalTwinForceOverwrite.test.ts
npm run typecheck
```

Expected: 单元测试 PASS，TypeScript 无错误。

- [ ] **Step 6: 提交弹窗变更**

```powershell
git add src/editor/deployment/digitalTwinForceOverwrite.ts tests/digitalTwin/digitalTwinForceOverwrite.test.ts src/editor/deployment/DigitalTwinPublishDialog.tsx
git commit -m "feat: confirm digital twin force overwrite"
```

---

### Task 5: 文档与跨仓库最终验证

**Files:**
- Modify: `C:\temp\babylon-3d-plus\README.md`

- [ ] **Step 1: 更新发布行为说明**

将 README 中“远端最新工程版本发生变化时禁止覆盖发布”改为：默认仍禁止；用户可在发布弹窗显式确认强制覆盖，以远端最新版本为基线创建下一版本；资源修订冲突和 prepare 后并发版本仍阻止发布。

- [ ] **Step 2: 运行编辑器完整定向验证**

```powershell
npm run test:digital-twin:unit
npm run test:digital-twin:integration
npm run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行数据中台 editor 模块验证**

```powershell
mvn -q -pl twin-module-editor -am -Dtest=DigitalTwinPublishValidatorTest,DigitalTwinPublishAppServiceTest -Dsurefire.failIfNoSpecifiedTests=false test -f backend/pom.xml
mvn -q -pl twin-module-editor -am -DskipTests package -f backend/pom.xml
```

Expected: 定向测试和模块编译打包 PASS。

- [ ] **Step 4: 检查两个仓库最终差异**

```powershell
git -C C:\temp\babylon-3d-plus diff --check
git -C C:\temp\babylon-3d-plus status --short
git -C C:\projects\CentralDataPlatform diff --check
git -C C:\projects\CentralDataPlatform status --short
```

Expected: 无 whitespace 错误；数据中台原有未提交文件保持不变且不进入本任务提交。

- [ ] **Step 5: 提交 README**

```powershell
git add README.md
git commit -m "docs: explain digital twin force overwrite"
```

- [ ] **Step 6: 执行代码审查**

按 `code-reviewer` 检查：默认兼容性、Long ID 字符串传输、prepare/commit 竞态、资源修订不可绕过、IPC 类型一致性、UI 重置状态、测试覆盖和两个仓库的无关改动隔离。发现问题后先补失败测试，再修复并重新运行相关验证。
