# 参数化工作台内部接口

本文件只记录当前实现的模块边界；用户方案位于模型工作目录 `docs/tasks/parametric-authoring-plan.md`。工作台使用 React、Babylon.js 9.12、TypeScript 和已安装的 fflate，不改用户模型或全局场景 store。

## 共享约定

- `types.ts` 由主代理维护，其他模块只读。参数表达式引用 parameter.key；数值参数统一使用米、角度使用度。UI 可显示单位但不再次转换宿主 contentRoot。
- AuthoringSession 保存 project 和独立 assets Map。JSON 配方不含图片二进制、Blob URL 或机器路径。模型原文件和元数据不可变，导出生成新包。
- 新模块在 `src/editor/authoring/`。读取部分 `.ts` 时专用 Read 会显示二进制，正常 Node fs.readFileSync 可以返回文本；不要自行解密或改变编码。不修改已有用户改动。
- 当前 source.unitScale 等于宿主 contentRoot 的单位倍率；root 为 contentRoot，不是场景实体根。
- 未知旧脚本不自动执行；仅代码摘要匹配内置 conveyor/shelf/shuttle 模板的脚本允许模板模式。新生成脚本只使用本地受限表达式和固定运行实现。
- 不创建或修改测试，不跑整库构建。主代理通过正式浏览器预览验证本功能。

## 并行写入边界

- 几何模块：`expression.ts`、`portableGeometry.ts`。表达式解析禁止 eval。portableGeometry 的运行函数自身闭包必须完整，不依赖外部值，便于将原源码嵌入导出脚本。
- 外观模块：`portableAppearance.ts`。同样提供完整闭包运行函数；不得写几何模块、UI、IO 或共享类型。
- 资产与宿主模块：`io.ts`、`generator.ts`、`hostBridge.ts`、`templates/`。使用真实宿主 ExternalModelScriptRuntime；脚本生成共享 portable 模块源码，不重写另一套规则。
- 主代理：工作台 React 组件、样式、视口、状态与历史、入口、开发服务、文档及集成。

## portableGeometry 契约

`createAuthoringGeometry(B, root, options = {})`，B 为 Babylon 完整 namespace；函数可以使用内部 TypeScript any，但无外部 imports。

返回：
- `inspect(): AuthoringNode[]`：源模型节点，稳定 id、selector、geometryFingerprint、米制 bounds；id 在同一源模型不同加载中保持一致，优先 glTF metadata pointer，否则相对路径+同名序号。排除自身生成对象。
- `apply(project, values): { ok: boolean, issues: AuthoringIssue[] }`：依据不可变基线更新 resize/stretch/translate/rotate/array/visibility/color。异常或约束失败保留上一次完整结果；重复相同输入不重建。
- `getContext()`：返回 `{ root, unitScale, nodes, meshes, generated, revision, getMesh(id), getTargets(id), getModelMatrix(mesh), getAnchor(anchor) }`。meshes 为源 id→Babylon Mesh 的 Map；nodes 为 inspect 结果；generated 为 `{sourceId,mesh}` 数组；getTargets 返回源与该源的生成副本；getModelMatrix 将 mesh 局部坐标变换到模型米制坐标；getAnchor 返回当前 `{point,normal,tangent,scaleU,scaleV}` 的数值三元组。
- `restore()`：恢复源基线并清除自身生成对象；保留原始数据，不销毁借用材质。
- `rebase()`：仅在已 restore 后、可信旧模板完成更新后重新采集当前基线，仍保留稳定 id。
- `dispose()`：恢复并清理自身资源。

geometryFingerprint 仅在静态来源首次对应时严格匹配；模板模式 source 几何经可信模板改变时仍须按稳定 selector 匹配，但不得因旧几何摘要阻止合法尺寸更新。targets 为 nodeId；UI 分组存于 parts，添加规则时展开为 nodeIds。

expression.ts 提供 `evaluateExpression(expression, values): number`、`resolveParameterValues(parameters): {values,issues}`、`validateProject(project): AuthoringIssue[]`。导出运行函数也必须能独立解析相同表达式；建议 expression.ts 导出一个闭包 `createExpressionEvaluator()`，portableGeometry 可从 options.evaluate 获得函数，未提供时使用其内嵌的同一个源码版本（由主代理集成，不复制算法）。

## portableAppearance 契约

`createAuthoringAppearance(B, scene, getGeometryContext, options = {})`，完整闭包，所有资源通过 options.resolveTexture(id) 得到 URL；无全局文件/DOM路径依赖。

返回：
- `apply(project, values): Promise<{ok:boolean,issues:AuthoringIssue[]}>`：按 project.layers/regions 顺序更新，图片加载成功才替换旧外观；避免在连续更新时旧异步结果覆盖新结果。
- `refreshAnchors()`：几何/运动变化后更新局部投影锚点和尺寸，不重复上传纹理。
- `restore()`：恢复基线材质并解除自有插件/网格；保留源图像。
- `dispose()`：释放自身材质、纹理包装、遮罩/辅助几何，不销毁借用资源。

region.anchor.point/normal/tangent 为模型米制坐标，barycentric 为按顶点索引顺序的三个权重。rectangle/polygon 的 width/height/depth 为米；polygon.points 是相对区域中心、按宽高归一的坐标（通常 [-0.5,0.5]）。region.offset 为米制平移。layer.offset 为贴花米制平移或 UV 纹理的 UV 偏移；layer.width/height 为贴花物理尺寸。rotation 为度。faceIndex 是源索引数组的三角形序号。whole/faces 区域可挂 color 或 texture；decal 通常使用 rectangle region。

layer bindings 的数字字段为受限表达式，color/visible 为参数key（不执行代码）。只支持明确的 PBR/Standard 材质，对不支持材质报告错误。局部颜色不能退化成整件改色，重叠UV不得串色，图层材质需按源部件隔离。

## IO / Host 契约

io.ts 提供：
- `readImportFile(file): Promise<AuthoringSession | ImportedArchive>`；`.pa.zip` 读取编辑工程、GLB 创建新工程、模型 ZIP 返回候选。
- `openArchiveCandidate(archive,id): Promise<AuthoringSession>`。
- `loadCatalogModel(item:CatalogModel): Promise<AuthoringSession>`。
- `addImageAsset(file): Promise<BinaryAsset>`。
- `saveProjectFile(session): Promise<void>`（浏览器下载包含全部依赖的工程ZIP）。
- `persistSession(session): Promise<void>`、`readSavedSession(): Promise<AuthoringSession|null>`（IndexedDB，保留错误而不是伪造已保存）。
- `downloadBytes(bytes,name,mime?)`。

generator.ts 提供 `generateModelScript(project, assets): Promise<string>`、`exportModelPackage(session): Promise<void>`、`createGeneratedArtifacts(session): Promise<{script:string,meta:Record<string,unknown>,modelJson:Record<string,unknown>,files:Record<string,Uint8Array>}>`。若模型资产丢失、规则非法、图像缺失，不生成伪成功包。保留未知原元数据字段，更新声明和 values，不覆盖外部工程场景。

hostBridge.ts 提供 `createLegacyPreview(root,session): Promise<{ update(values):void; dispose():void; getError():string|null } | null>`。只允许摘要命中的内置模板；模板 original Runtime 由正式 ExternalModelScriptRuntime 执行，unit/metadata 与正式宿主一致。

UI 会先 legacyPreview，再 geometry.inspect/rebase。变更参数时恢复自有外观和几何，然后 legacy.update、geometry.rebase、geometry.apply、appearance.apply；稳定帧只更新模板时间行为和表面锚点。导出必须组合可信模板与新增规则，保留未转换的原模板逻辑，不执行未知脚本。
