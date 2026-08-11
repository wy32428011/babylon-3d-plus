# Auto Patrol Model Selection Implementation Plan

> **For agentic workers:** Implement task-by-task using TDD; do not commit automatically because the shared workspace already contains unrelated user changes.

**Goal:** Add read-only model click selection during automatic patrol to the editor runtime preview and published Viewer without interrupting patrol playback.

**Architecture:** Share pointer click classification between both entry points, add a runtime-only model picking policy that ignores authoring locks but filters non-model helpers, and keep Viewer-local highlights separate from existing external focus highlights. Reuse the existing `SelectionOutlineLayer` for all highlight sources.

**Tech Stack:** React 19, TypeScript, Babylon.js 9, Node.js test runner.

---

### Task 1: Shared pointer click classification

**Files:**
- Create: `src/shared/sceneModelSelectionPointer.ts`
- Create: `tests/digitalTwin/sceneModelSelectionPointer.test.ts`

- [ ] Add failing tests for primary mouse/touch taps, drag threshold, out-and-back movement, mismatched pointer IDs, and release coordinates.
- [ ] Run the new test and confirm it fails because the helper does not exist.
- [ ] Implement the minimal immutable pointer snapshot helpers.
- [ ] Re-run the test and confirm it passes.

### Task 2: Independent Viewer-local highlight source

**Files:**
- Modify: `src/runtime/babylon/sceneRuntimeHighlight.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`
- Modify: `tests/digitalTwin/externalAssetHighlight.test.ts`

- [ ] Extend tests so editor selection, Viewer-local selection, and external focus highlights merge without mutating inputs.
- [ ] Run the highlight test and confirm the three-source expectation fails.
- [ ] Add `setLocalHighlightEntityIds` / `clearLocalHighlight` and include the local source in presentation sync, full-sync cleanup, outline rebuild, and disposal.
- [ ] Re-run the highlight test.

### Task 3: Runtime-only business-model picking

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`
- Create or modify: focused runtime picking tests under `tests/digitalTwin/`

- [ ] Add a failing contract test for the runtime candidate policy: visible business models and arrays are accepted; locked remains accepted; helpers and hidden entities are rejected.
- [ ] Implement `pickRuntimeModelEntityIdAtCanvasPoint` using nearest visible mesh/thinInstance and existing bounds fallback.
- [ ] Keep `pickEntityIdAtCanvasPoint` unchanged for ordinary edit-mode semantics.
- [ ] Run the focused test and existing model-picking smoke test.

### Task 4: Editor runtime-preview integration

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`

- [ ] Replace camera-pose-based click cancellation with the shared pointer trajectory threshold.
- [ ] In runtime preview, skip patrol marker picking and use runtime business-model picking; preserve normal edit-mode behavior and Ctrl/Cmd multi-select.
- [ ] Verify selection still flows through the existing store so Hierarchy and Inspector update while mutation guards and Gizmo rules remain unchanged.

### Task 5: Published Viewer integration

**Files:**
- Modify: `src/player/PlayerApp.tsx`

- [ ] Bind pointer down/move/up/cancel listeners after runtime initialization.
- [ ] Select at pointer-up coordinates, replace Viewer-local selection, and clear on empty click.
- [ ] Keep drag/wheel/keyboard manual camera notifications, but do not classify a tap as camera takeover.
- [ ] Remove all added listeners during failed startup and component disposal.

### Task 6: Verification and review

- [ ] Run new focused tests and existing digital-twin unit tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run smoke:model-picking` when the environment supports the existing smoke fixture.
- [ ] Review `git diff` for accidental changes and ensure existing user edits remain intact.
- [ ] Perform code review focused on listener cleanup, selection-source isolation, thinInstance correctness, and runtime performance.

