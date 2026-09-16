import React from 'react';
import { createRoot } from 'react-dom/client';
import { AlarmManagerInspector } from '/src/editor/panels/AlarmManagerInspector';
import { createAlarmManagerEntity } from '/src/editor/model/alarmManager';
import { createEmptySceneDocument, createModelEntity } from '/src/editor/model/SceneDocument';
import { serializeScene, deserializeScene } from '/src/editor/project/SceneSerializer';
import { useEditorStore } from '/src/editor/store/editorStore';
import { deviceTelemetryStore, parseDeviceTelemetryMessage } from '/src/runtime/mqtt/deviceTelemetry';
import '/src/styles/global.css';

const manager = createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
const config = manager.components.alarmManager!;
config.listenProperty = 'CUSTOM PROPERTY';
config.warehouseAlarm = false;
const scene = createEmptySceneDocument('报警点位诊断');
scene.entityIds.push(manager.id); scene.entities[manager.id] = manager; scene.selectedEntityId = manager.id;
for (let index = 0; index < 12; index++) {
  const target = createModelEntity('C:/fixtures/device.glb', 'editor-asset://local/device.glb', '设备 ' + (index + 1));
  target.components.modelAsset!.assetCode = 'CV-' + (index + 1);
  target.components.telemetryBinding = { enabled: true, sourceId: 'default', deviceType: 'conveyor', expectedIntervalMs: 500, staleAfterMs: 1500 };
  scene.entityIds.push(target.id); scene.entities[target.id] = target;
  config.targets.push({ id: 'slot-' + index, model: null, entityId: target.id });
}
useEditorStore.setState({ scene, runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, hierarchySelectionIds: [manager.id] });
function Inspector() {
  const entity = useEditorStore(state => state.scene.entities[manager.id]);
  const disabled = useEditorStore(state => state.runtimeMode === 'preview');
  return React.createElement(AlarmManagerInspector, { entity, disabled });
}
const root = createRoot(document.getElementById('root')!);
root.render(React.createElement(Inspector));
let sequence = 0;
Object.assign(window, { alarmInspectorHarness: {
  run: () => useEditorStore.setState({ runtimeMode: 'preview' }),
  stop: () => { deviceTelemetryStore.clear(); useEditorStore.setState({ runtimeMode: 'edit' }); },
  mqtt: (data: unknown[], assetCode = 'CV-1', sourceId = 'default') => {
    const snapshot = parseDeviceTelemetryMessage(`dt/factory/logistics/conveyor/${assetCode}/twindatadriven/joint`, JSON.stringify({ seq: ++sequence, data }), { kind: 'epv', sourceId });
    if (!snapshot) throw new Error('诊断报文解析失败');
    deviceTelemetryStore.upsert(snapshot);
  },
  inspect: () => {
    const state = useEditorStore.getState();
    return { config: state.scene.entities[manager.id].components.alarmManager, undoCount: state.history.undoStack.length };
  },
  reload: () => {
    const state = useEditorStore.getState();
    const reloaded = deserializeScene(serializeScene(state.scene));
    reloaded.selectedEntityId = manager.id;
    useEditorStore.setState({ scene: reloaded, sceneSessionId: state.sceneSessionId + 1 });
  },
  undo: () => useEditorStore.getState().undo(),
  redo: () => useEditorStore.getState().redo(),
  dispose: () => { root.unmount(); deviceTelemetryStore.clear(); },
} });
