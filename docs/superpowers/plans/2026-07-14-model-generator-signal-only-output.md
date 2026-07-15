# Model Generator Signal-Only Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make model-generator targets configuration-only in edit mode and create runtime output only while an MQTT rule is matched.

**Architecture:** Keep the existing scene schema and stable Babylon root. Change target resolution so edit mode and unmatched runtime states resolve to null, while the first matched rule with a valid target resolves to rule.target or the shared defaultTarget template. Preserve existing load-token, fallback, picking, undo, copy and reimport paths.

**Tech Stack:** TypeScript, React, Zustand, Babylon.js, Electron/Vite.

---

### Task 1: Update Inspector semantics

**Files:**
- Modify: src/editor/panels/ModelGeneratorInspector.tsx

- [ ] Rename the default slot label to 共享生成模板.
- [ ] Rename rule target labels to 规则覆盖模型（可选）.
- [ ] Update empty-state and TTL guidance so they state that output exists only while a rule is matched.
- [ ] Keep the existing component fields and undoable update entrypoint unchanged.

### Task 2: Change runtime target resolution

**Files:**
- Modify: src/runtime/babylon/SceneRuntime.ts

- [ ] Make edit mode resolve to null so target snapshots never instantiate while editing.
- [ ] Make missing, stale or unmatched telemetry resolve to null instead of defaultTarget.
- [ ] For matching rules, resolve the first rule with a valid candidate target: rule.target first and defaultTarget as the shared template fallback.
- [ ] Ignore a matching incomplete rule when both rule.target and defaultTarget are empty, then continue scanning later rules.
- [ ] Preserve ordered scanning, latest snapshot selection and complete binding filtering; the first returned match must have a valid target.
- [ ] Keep conditional-load failure fallback limited to the same active signal; if the shared template also fails, remain empty.
- [ ] Preserve stable root, load token, picking metadata and complete disposal behavior.

### Task 3: Update documentation

**Files:**
- Modify: README.md

- [ ] Replace edit-mode default-model wording with configuration-only template behavior.
- [ ] Replace no-match and TTL fallback wording with output disposal behavior.
- [ ] Document the optional per-rule override and shared-template fallback.
- [ ] Add a conveyor front_has_goods/back_has_goods example where both rule override targets may be empty and the shared template supplies the cargo model.

### Task 4: Verify behavior

**Files:**
- No persistent test files required.

- [ ] Run npm run typecheck and expect exit code 0.
- [ ] Run npm run build and expect exit code 0.
- [ ] Run git diff --check and expect no whitespace errors.
- [ ] Smoke-check edit marker, unmatched runtime empty state, matched signal generation, signal reset and TTL disposal.
- [ ] Close only processes started for this task and preserve unrelated port 5242/Electron processes.
