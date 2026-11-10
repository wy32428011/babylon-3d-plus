@AGENTS.md

# Claude Code 项目补充

共享工程约束统一维护在根目录 `AGENTS.md`；本文件通过上述相对导入加载它，不重复技术栈、命令和领域规则。

- 修改子目录前，应用该目录已有的局部指令；Claude 路径规则放在 `.claude/rules/` 并使用 `paths` frontmatter。仅在确有目录差异时增加局部规则。
- 技能按任务匹配后再加载 `SKILL.md` 及相关参考资料，不把整个技能库导入项目上下文。名称以当前会话的技能列表为准；插件技能使用列表中的完整命名空间。
- `.claude/settings.json` 中声明启用插件，不等于插件、技能或 MCP 已安装、连接或获得授权。Blender 等外部工具按实际连接状态使用；技能说明不提供工具连接能力。
- 个人项目偏好和本机路径放在已忽略的 `CLAUDE.local.md` 或本机配置中；权限、hooks 和环境配置由对应设置管理，不用本文件声称强制执行。

## 维护依据

维护时核对官方加载规则与技能规范，保持本文件精简；新增跨工具工程约束写入 `AGENTS.md`。

- [Claude Code 项目记忆、导入与路径规则](https://code.claude.com/docs/en/memory)
- [Claude Code 技能目录与调用方式](https://code.claude.com/docs/en/skills)
- [AGENTS.md 格式与范围](https://agents.md/)
