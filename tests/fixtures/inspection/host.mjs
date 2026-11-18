/* global document, location, window */
const frame = document.getElementById('detail');
const channel = 'zending.digital-twin.bridge';
const sessionId = 'inspection-page-test-session';
const sourceUrl = `editor-asset://local/${encodeURIComponent('project/assets/assembly-animation.glb')}`;
const events = [];
let sequence = 0;
let ready = false;
let negotiated = false;

const part = (partKey, name, nodePath, fixed, parentPartKey) => ({
  partKey, name, nodePath, fixed, axis: { x: 1, y: 0, z: 0 }, distanceMeters: fixed ? 0 : 0.5,
  ...(parentPartKey ? { parentPartKey } : {}),
});
const binding = {
  schemaVersion: 1,
  device: { namespace: 'fixture', deviceType: 'conveyor', deviceNo: 'CV-021' },
  model: {
    dataPlatformModel: { sourceKey: 'fixture', kind: 'model', resourceId: '9007199254740994', modelPath: 'assembly-animation.glb' },
    versionId: '9007199254740995', contentSha256: 'a'.repeat(64),
    sourcePath: 'assembly-animation.glb', sourceUrl, metaPath: 'meta.json',
    metaUrl: `editor-asset://local/${encodeURIComponent('project/assets/meta.json')}`,
    unitScaleToMeters: 1,
  },
  configuration: { id: 'fixture-configuration', parameters: {} },
  parts: [
    part('assembly.base', '底座', 'AssemblyRoot/Base', true),
    part('drive.motor', '电机', 'AssemblyRoot/DriveAssembly/Motor', false, 'drive'),
    part('drive', '驱动组件', 'AssemblyRoot/DriveAssembly', false),
    part('drive.guard', '防护罩', 'AssemblyRoot/Guard', false),
  ],
};

function send(type, payload, requestId = `request-${++sequence}`, targetSession = sessionId) {
  const message = { channel, version: 1, sessionId: targetSession, type };
  if (type !== 'host.hello') message.requestId = requestId;
  if (payload !== undefined) message.payload = payload;
  frame.contentWindow.postMessage(message, location.origin);
  return requestId;
}

function load(loadId = 'load-1', modelUrl = sourceUrl) {
  return send('command.inspectionLoad', {
    loadId, assetCode: 'CV-021', entityId: 'fixture-entity',
    inspection: { ...binding, model: { ...binding.model, sourceUrl: modelUrl } },
  });
}

function loadVersion(loadId = 'load-model-version', fileUrl = new URL('/api/v1/files/assembly-animation.glb', location.href).href, fileExtension = '.glb') {
  return send('command.inspectionLoadModelVersion', {
    loadId, assetCode: 'CV-021', entityId: 'fixture-entity',
    inspection: {
      schemaVersion: 2, source: 'model-version', device: { deviceType: 'conveyor' },
      model: { modelId: '9007199254740994', versionId: '9007199254740995', fileUrl, fileExtension, unitScaleToMeters: 1 },
      parts: binding.parts,
    },
  });
}

window.inspectionFixture = { events, send, load, loadVersion, sourceUrl, sessionId };
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.sessionId !== sessionId) return;
  events.push(event.data);
  if (event.data.type === 'viewer.ready' && !ready) {
    ready = true;
    send('host.inspectionHello', { role: 'detail' });
  }
  if (event.data.type === 'viewer.inspectionReady' && !negotiated) {
    negotiated = true;
    load();
  }
});
const helloTimer = window.setInterval(() => {
  if (ready) window.clearInterval(helloTimer);
  else send('host.hello');
}, 500);
