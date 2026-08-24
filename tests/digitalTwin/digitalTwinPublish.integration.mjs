import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import unzipper from 'unzipper';

const PROJECT_ID = '2054201280000000001';
const EDITOR_PROJECT_ID = '2054201280000000101';
const BASE_VERSION_ID = '2054201280000000201';
const NEW_VERSION_ID = '2054201280000000202';
const RESOURCE_REVISION = '2054201280000000301';
const NEW_RESOURCE_REVISION = '2054201280000000302';
const SUCCESS_REQUEST_ID = 'success-overwrite-resource-confirm';
const MISSING_CONFIRM_REQUEST_ID = 'missing-resource-confirm';
const RESOURCE_CONFLICT_REQUEST_ID = 'resource-revision-conflict';
const COMMIT_CONFLICT_REQUEST_ID = 'commit-version-conflict';
const VERSION_CONFLICT_REQUEST_ID = 'version-conflict';
const FORCE_OVERWRITE_REQUEST_ID = 'force-version-overwrite';
const CANCEL_REQUEST_ID = 'cancel-upload';
const UPLOAD_FAILURE_REQUEST_ID = 'permanent-upload-failure';
const MISMATCHED_PREPARE_REQUEST_ID = 'mismatched-prepare-response';
const RUNTIME_CONFIG_FAILURE_REQUEST_ID = 'runtime-config-save-failure';
const BOUND_PROJECT_SWITCH_REQUEST_ID = 'bound-project-switch';
const UNBOUND_NO_PROJECT_REQUEST_ID = 'unbound-no-project';
const SELECTED_PROJECT_CONFIRM_REQUEST_ID = 'selected-project-confirm';
const SELECTED_PROJECT_REQUEST_ID = 'selected-project-bind';
const INDEXED_SKYBOX_REQUEST_ID = 'skybox-indexed-active';
const ORPHANED_SKYBOX_REQUEST_ID = 'skybox-indexed-orphaned';
const SOURCE_SKYBOX_TOCTOU_REQUEST_ID = 'skybox-source-toctou';
const DIST_SKYBOX_TOCTOU_REQUEST_ID = 'skybox-dist-toctou';
const OTHER_PROJECT_ID = '2054201280000000998';
const PRIMARY_SKYBOX_ID = '2054201280000000401';
const UNUSED_SKYBOX_ID = '2054201280000000402';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PUBLISH_PARENT_ORIGINS = ['https://screen.example.com', 'http://127.0.0.1:8001'];
const PUBLISHED_FETCH_CONFIG = Object.freeze({
  url: 'https://fetch.example.test/inventory',
  apiKey: 'integration-test-api-key',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createHdrFixture(comment = 'fixture', baseValue = 32) {
  const header = Buffer.from(`#?RADIANCE\nCOMMENT=${comment}\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n`, 'ascii');
  const scanline = [Buffer.from([2, 2, 0, 8])];
  for (let channel = 0; channel < 4; channel += 1) {
    scanline.push(Buffer.from([8]), Buffer.alloc(8, baseValue + channel));
  }
  return Buffer.concat([header, ...scanline]);
}

function createCorruptHdrFixture() {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', 'ascii');
  return Buffer.concat([header, Buffer.from([2, 2, 0, 8, 137, 10])]);
}

function createDataPlatformSkyboxEntry(resourceId, displayName, data, status = 'active') {
  return {
    resourceId,
    displayName,
    relativePath: `Assets/Skyboxes/DataPlatform/Skybox-${resourceId}/skybox.hdr`,
    format: 'hdr',
    fileSizeBytes: data.length,
    sha256: sha256(data),
    revision: '1',
    status,
    syncedAt: '2026-08-10T08:00:00.000Z',
  };
}

async function writeDataPlatformSkyboxIndex(editorRoot, entries) {
  const indexPath = path.join(editorRoot, '.babylon-editor', 'data-platform-skybox-index.json');
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
}

function createDataPlatformSkyboxSceneContent(resourceId, baseUrl, overrides = {}) {
  const remoteUrl = `${baseUrl}/api/v1/skyboxes/${resourceId}/download`;
  const skybox = {
    packagePath: `${baseUrl}/api/v1/skyboxes/${resourceId}/`,
    sourcePath: remoteUrl,
    sourceUrl: remoteUrl,
    format: 'hdr',
    intensity: 1,
    rotationY: 0,
    dataPlatformResourceId: resourceId,
    ...overrides,
  };
  return `${JSON.stringify({
    version: 3,
    scene: {
      id: `scene_skybox_${resourceId}`,
      name: '数据中台天空盒发布场景',
      entityIds: ['skybox-reference'],
      entities: {
        'skybox-reference': {
          id: 'skybox-reference',
          name: '重复天空盒引用',
          components: { skybox: { ...skybox } },
        },
      },
      selectedEntityId: null,
      sceneSettings: {
        camera: { savedPose: null, viewDistance: 5000 },
        sensitivity: { zoom: 10, pan: 10, rotate: 10 },
        environment: null,
        skybox: { ...skybox },
      },
    },
  }, null, 2)}\n`;
}

function createLocalSkyboxSceneContent(sourcePath) {
  const sourceUrl = `editor-asset://local/${encodeURIComponent(sourcePath)}`;
  return `${JSON.stringify({
    version: 3,
    scene: {
      id: 'scene_local_skybox',
      name: '本地天空盒发布场景',
      entityIds: [],
      entities: {},
      selectedEntityId: null,
      sceneSettings: {
        camera: { savedPose: null, viewDistance: 5000 },
        sensitivity: { zoom: 10, pan: 10, rotate: 10 },
        environment: null,
        skybox: {
          packagePath: path.dirname(sourcePath),
          sourcePath,
          sourceUrl,
          format: 'hdr',
          intensity: 1,
          rotationY: 0,
        },
      },
    },
  }, null, 2)}\n`;
}

async function readZipEntries(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const entries = new Map();
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    entries.set(entry.path.replace(/\\/g, '/'), await entry.buffer());
  }
  return entries;
}


async function readZipFileEntries(filePath) {
  const directory = await unzipper.Open.file(filePath);
  const entries = new Map();
  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    entries.set(entry.path.replace(/\\/g, '/'), await entry.buffer());
  }
  return entries;
}

function createSceneContent() {
  return `${JSON.stringify({
    version: 3,
    scene: {
      id: 'scene_digital_twin_publish_integration',
      name: '数字孪生发布集成场景',
      fetchConfig: { ...PUBLISHED_FETCH_CONFIG },
      entityIds: ['cad-reference'],
      entities: {
        'cad-reference': {
          id: 'cad-reference',
          name: '发布时跳过的 CAD',
          components: {
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
            cadReference: {
              sourcePath: 'C:\\missing-digital-twin-cad\\layout.dxf',
              sourceUrl: 'editor-asset://local/C%3A%5Cmissing-digital-twin-cad%5Clayout.dxf',
            },
          },
        },
      },
      selectedEntityId: null,
      sceneSettings: {
        camera: { savedPose: null, viewDistance: 5000 },
        sensitivity: { zoom: 10, pan: 10, rotate: 10 },
        environment: null,
      },
    },
  }, null, 2)}\n`;
}

function createRemoteStatus(overrides = {}) {
  const projectId = overrides.projectId ?? PROJECT_ID;
  return {
    projectId,
    editorProjectId: EDITOR_PROJECT_ID,
    latestVersionId: BASE_VERSION_ID,
    latestVersionNumber: 1,
    onlineVersionId: BASE_VERSION_ID,
    onlineVersionNumber: 1,
    status: 'ONLINE',
    stableUrl: `http://127.0.0.1/digital-twin/projects/${PROJECT_ID}/`,
    releaseUrl: `http://127.0.0.1/digital-twin/releases/${PROJECT_ID}/1/`,
    lastPublishedAt: '2026-08-01T08:00:00',
    runtimeConfig: {
      projectId,
      mqttBrokerUrl: 'ws://broker.internal:8083/mqtt',
      apiBaseUrl: 'https://api.internal/runtime',
      runtimeEnabled: false,
      configJson: JSON.stringify({
        telemetryInterval: 1000,
        integration: {
          futureField: true,
          allowedParentOrigins: ['https://existing.example.com'],
        },
      }),
      updatedAt: '2026-08-01T08:00:00',
    },
    ...overrides,
  };
}

function createPublishRequest(requestId, sceneContent, overrides = {}) {
  return {
    requestId,
    publishName: `发布-${requestId}`,
    remark: 'Electron mock API 集成测试',
    sceneContent,
    projectId: null,
    overwriteExisting: true,
    forceOverwrite: false,
    confirmResourceBindings: false,
    allowedParentOrigins: PUBLISH_PARENT_ORIGINS,
    ...overrides,
  };
}

class DigitalTwinMockServer {
  constructor() {
    this.server = null;
    this.baseUrl = '';
    this.requests = [];
    this.sessions = new Map();
    this.tasks = new Map();
    this.remoteStatus = createRemoteStatus();
    this.projectDetailId = PROJECT_ID;
    this.projectDetailOverrides = {};
    this.nextId = 2054201281000000000n;
    this.cancelChunkStarted = null;
    this.resolveCancelChunkStarted = null;
    this.cancelChunkGate = null;
    this.releaseCancelChunkGate = null;
    this.failNextStatus = false;
    this.failNextRuntimeConfigSave = false;
    this.redirectNextStatus = false;
  }

  allocateId() {
    const result = String(this.nextId);
    this.nextId += 1n;
    return result;
  }

  async start() {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (response.destroyed || response.writableEnded) return;
        this.sendJson(response, {
          success: false,
          code: 'MOCK_SERVER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          data: null,
        }, 500);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('mock server address 无效。');
    this.baseUrl = `http://127.0.0.1:${address.port}/platform`;
  }

  async close() {
    this.releaseDelayedCancelChunk();
    if (!this.server) return;
    await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server = null;
  }

  setRemoteStatus(status) {
    this.remoteStatus = { ...status };
  }

  resetRequests() {
    this.requests.length = 0;
  }

  async waitForCancelChunkStart() {
    if (!this.cancelChunkStarted) {
      this.cancelChunkStarted = new Promise((resolve) => {
        this.resolveCancelChunkStarted = resolve;
      });
    }
    await Promise.race([
      this.cancelChunkStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('等待取消场景上传分片超时。')), 20000)),
    ]);
  }

  releaseDelayedCancelChunk() {
    this.releaseCancelChunkGate?.();
    this.releaseCancelChunkGate = null;
    this.cancelChunkGate = null;
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const rawBody = await this.readRequestBody(request);
    const contentType = String(request.headers['content-type'] ?? '');
    const body = contentType.includes('application/json') && rawBody.length > 0
      ? JSON.parse(rawBody.toString('utf8'))
      : rawBody;
    this.requests.push({
      method: request.method,
      path: url.pathname,
      body,
      headers: { ...request.headers },
    });

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/projects/detail') {
      assert.deepEqual(body, { id: PROJECT_ID });
      this.sendSuccess(response, {
        id: this.projectDetailId,
        projectName: '发布集成测试项目',
        sceneCount: 0,
        screenCount: 0,
        modelCount: 0,
        envModelCount: 0,
        comboModelCount: 0,
        poiCount: 0,
        chartCount: 0,
        themeCount: 0,
        latestEditorProjectId: this.remoteStatus.editorProjectId,
        latestEditorProjectVersionId: this.remoteStatus.latestVersionId,
        latestEditorProjectVersionNumber: this.remoteStatus.latestVersionNumber,
        latestEditorProjectName: '发布集成测试工程',
        latestEditorProjectPackageUrl: null,
        latestEditorProjectPackageFileName: null,
        currentResourceRevision: RESOURCE_REVISION,
        publishedResourceRevision: RESOURCE_REVISION,
        digitalTwinStatus: this.remoteStatus.status,
        onlineDigitalTwinVersionId: this.remoteStatus.onlineVersionId,
        onlineDigitalTwinVersionNumber: this.remoteStatus.onlineVersionNumber,
        onlineDigitalTwinPublishId: null,
        onlineProjectPublishId: null,
        digitalTwinStableUrl: this.remoteStatus.stableUrl,
        digitalTwinReleaseUrl: this.remoteStatus.releaseUrl,
        digitalTwinLastPublishedAt: this.remoteStatus.lastPublishedAt,
        updatedAt: '2026-08-01T08:00:00',
        ...this.projectDetailOverrides,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/digital-twin/projects/status') {
      assert.deepEqual(body, { projectId: PROJECT_ID });
      if (this.redirectNextStatus) {
        this.redirectNextStatus = false;
        response.writeHead(302, { location: `${this.baseUrl}/redirect-target` });
        response.end();
      } else if (this.failNextStatus) {
        this.failNextStatus = false;
        this.sendJson(response, { success: false, code: 'STATUS_REFRESH_UNAVAILABLE', message: '状态刷新暂时不可用', data: null }, 503);
      } else {
        this.sendSuccess(response, this.remoteStatus);
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/digital-twin/runtime-config/save') {
      assert.equal(body.projectId, PROJECT_ID);
      if (this.failNextRuntimeConfigSave) {
        this.failNextRuntimeConfigSave = false;
        this.sendJson(response, {
          success: false,
          code: 'DIGITAL_TWIN_RUNTIME_CONFIG_SAVE_FAILED',
          message: '模拟运行配置保存失败',
          data: null,
        }, 500);
        return;
      }
      this.remoteStatus.runtimeConfig = {
        projectId: PROJECT_ID,
        mqttBrokerUrl: body.mqttBrokerUrl ?? null,
        apiBaseUrl: body.apiBaseUrl ?? null,
        runtimeEnabled: body.runtimeEnabled !== false,
        configJson: body.configJson ?? null,
        updatedAt: '2026-08-06T17:00:00',
      };
      this.sendSuccess(response, this.remoteStatus.runtimeConfig);
      return;
    }

    if (url.pathname === '/platform/redirect-json' || url.pathname === '/platform/redirect-file') {
      response.writeHead(302, { location: `${this.baseUrl}/redirect-target` });
      response.end();
      return;
    }

    if (url.pathname === '/platform/redirect-target') {
      this.sendSuccess(response, this.remoteStatus);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/digital-twin/publish-tasks/prepare') {
      await this.handlePrepare(response, body);
      return;
    }

    const uploadDetailMatch = /^\/platform\/api\/v1\/digital-twin\/uploads\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && uploadDetailMatch) {
      this.sendSuccess(response, this.toSessionResponse(this.getSession(uploadDetailMatch[1])));
      return;
    }

    const uploadChunkMatch = /^\/platform\/api\/v1\/digital-twin\/uploads\/(\d+)\/chunks\/(\d+)$/.exec(url.pathname);
    if (request.method === 'PUT' && uploadChunkMatch) {
      await this.handleChunk(response, uploadChunkMatch[1], Number(uploadChunkMatch[2]), rawBody);
      return;
    }

    const uploadCompleteMatch = /^\/platform\/api\/v1\/digital-twin\/uploads\/(\d+)\/complete$/.exec(url.pathname);
    if (request.method === 'POST' && uploadCompleteMatch) {
      this.handleComplete(response, uploadCompleteMatch[1]);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/digital-twin/publish-tasks/commit') {
      this.handleCommit(response, body);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/digital-twin/publish-tasks/cancel') {
      this.handleCancel(response, body);
      return;
    }

    this.sendJson(response, { success: false, code: 'NOT_FOUND', message: url.pathname, data: null }, 404);
  }

  async handlePrepare(response, body) {
    assert.equal(typeof body.requestId, 'string');
    assert.equal(body.projectId, PROJECT_ID);
    assert.equal(typeof body.baseVersionId, 'string');
    assert.match(body.sourcePackage.sha256, SHA256_PATTERN);
    assert.match(body.distPackage.sha256, SHA256_PATTERN);
    assert.ok(body.sourcePackage.fileSize > 0);
    assert.ok(body.distPackage.fileSize > 0);

    if (body.requestId === MISSING_CONFIRM_REQUEST_ID && body.confirmResourceBindings !== true) {
      this.sendJson(response, {
        success: false,
        code: 'DIGITAL_TWIN_RESOURCE_BINDING_CONFIRM_REQUIRED',
        message: '项目缺少数字孪生资源关联，请确认补充。',
        data: { missingModelIds: ['101'], missingEnvModelIds: [], missingComboModelIds: [] },
      }, 409);
      return;
    }
    if (body.requestId === RESOURCE_CONFLICT_REQUEST_ID) {
      this.sendJson(response, {
        success: false,
        code: 'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT',
        message: '项目资源修订已经变化。',
        data: { expectedRevision: body.resourceRevision, actualRevision: NEW_RESOURCE_REVISION },
      }, 409);
      return;
    }

    const taskId = this.allocateId();
    const sourceUpload = this.createSession(body.requestId, 'SOURCE', body.sourcePackage);
    const distUpload = this.createSession(body.requestId, 'DIST', body.distPackage);
    const task = {
      taskId,
      requestId: body.requestId,
      projectId: body.projectId,
      editorProjectId: EDITOR_PROJECT_ID,
      baseVersionId: body.forceOverwrite === true ? this.remoteStatus.latestVersionId : body.baseVersionId,
      projectResourceRevision: body.requestId === SUCCESS_REQUEST_ID && body.confirmResourceBindings === true
        ? NEW_RESOURCE_REVISION
        : body.resourceRevision,
      publishName: body.publishName,
      remark: body.remark,
      entryScenePath: body.entryScenePath,
      entrySceneName: body.entrySceneName,
      status: 'PREPARED',
      stage: 'UPLOADING',
      errorCode: null,
      errorMessage: null,
      sourceUpload: this.toSessionResponse(sourceUpload),
      distUpload: this.toSessionResponse(distUpload),
      editorProjectVersionId: null,
      editorProjectPublishId: null,
      projectPublishId: null,
      stableUrl: null,
      releaseUrl: null,
      createdAt: '2026-08-01T09:00:00',
      updatedAt: '2026-08-01T09:00:00',
    };
    if (body.requestId === MISMATCHED_PREPARE_REQUEST_ID) {
      task.projectId = '2054201280000000999';
    }
    this.tasks.set(taskId, { task, sourceUploadId: sourceUpload.uploadId, distUploadId: distUpload.uploadId });
    this.sendSuccess(response, task);
  }

  createSession(requestId, packageType, descriptor) {
    const uploadId = this.allocateId();
    const chunkSize = Math.max(1, Math.ceil(descriptor.fileSize / 3));
    const totalChunks = Math.ceil(descriptor.fileSize / chunkSize);
    const uploadedChunks = requestId === SUCCESS_REQUEST_ID && totalChunks > 1 ? new Set([0]) : new Set();
    const session = {
      requestId,
      uploadId,
      packageType,
      fileName: descriptor.fileName,
      fileSize: descriptor.fileSize,
      sha256: descriptor.sha256,
      chunkSize,
      totalChunks,
      uploadedChunks,
      completedFileId: null,
      status: 'UPLOADING',
      attempts: new Map(),
      chunkBodies: new Map(),
    };
    this.sessions.set(uploadId, session);
    return session;
  }

  getSession(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) throw new Error(`未知 uploadId：${uploadId}`);
    return session;
  }

  async handleChunk(response, uploadId, chunkIndex, rawBody) {
    const session = this.getSession(uploadId);
    assert.ok(chunkIndex >= 0 && chunkIndex < session.totalChunks, '上传分片索引越界。');
    const expectedBytes = Math.min(session.chunkSize, session.fileSize - chunkIndex * session.chunkSize);
    assert.equal(rawBody.length, expectedBytes, `${session.packageType} 分片长度不正确。`);
    const attempt = (session.attempts.get(chunkIndex) ?? 0) + 1;
    session.attempts.set(chunkIndex, attempt);

    if (session.requestId === SUCCESS_REQUEST_ID && session.packageType === 'SOURCE' && chunkIndex === 1 && attempt === 1) {
      this.sendJson(response, { success: false, code: 'TEMPORARY_UPLOAD_FAILURE', message: '临时上传失败', data: null }, 503);
      return;
    }

    if (session.requestId === UPLOAD_FAILURE_REQUEST_ID && session.packageType === 'SOURCE' && chunkIndex === 0) {
      this.sendJson(response, { success: false, code: 'PERMANENT_UPLOAD_FAILURE', message: '永久上传失败', data: null }, 503);
      return;
    }

    if (session.requestId === CANCEL_REQUEST_ID && !this.cancelChunkGate) {
      this.cancelChunkStarted ??= new Promise((resolve) => {
        this.resolveCancelChunkStarted = resolve;
      });
      this.cancelChunkGate = new Promise((resolve) => {
        this.releaseCancelChunkGate = resolve;
      });
      this.resolveCancelChunkStarted?.();
      await this.cancelChunkGate;
      if (response.destroyed || response.writableEnded) return;
    }

    session.chunkBodies ??= new Map();
    session.chunkBodies.set(chunkIndex, Buffer.from(rawBody));
    session.uploadedChunks.add(chunkIndex);
    this.sendSuccess(response, this.toSessionResponse(session));
  }

  handleComplete(response, uploadId) {
    const session = this.getSession(uploadId);
    assert.equal(session.uploadedChunks.size, session.totalChunks, `${session.packageType} 分片尚未完整上传。`);
    session.status = 'COMPLETED';
    session.completedFileId = this.allocateId();
    this.sendSuccess(response, this.toSessionResponse(session));
  }

  handleCommit(response, body) {
    const record = this.tasks.get(String(body.taskId));
    if (!record) throw new Error(`未知 taskId：${body.taskId}`);
    const source = this.getSession(record.sourceUploadId);
    const dist = this.getSession(record.distUploadId);
    assert.equal(source.status, 'COMPLETED');
    assert.equal(dist.status, 'COMPLETED');
    if (record.task.requestId === COMMIT_CONFLICT_REQUEST_ID) {
      this.sendJson(response, {
        success: false,
        code: 'DIGITAL_TWIN_VERSION_CONFLICT',
        message: '上传期间远端数字孪生工程产生了新版本。',
        data: { latestVersionId: NEW_VERSION_ID },
      }, 409);
      return;
    }
    record.task = {
      ...record.task,
      status: 'COMPLETED',
      stage: 'COMPLETED',
      sourceUpload: this.toSessionResponse(source),
      distUpload: this.toSessionResponse(dist),
      editorProjectVersionId: NEW_VERSION_ID,
      editorProjectPublishId: this.allocateId(),
      projectPublishId: this.allocateId(),
      stableUrl: `http://127.0.0.1/digital-twin/projects/${PROJECT_ID}/`,
      releaseUrl: `http://127.0.0.1/digital-twin/releases/${PROJECT_ID}/2/`,
      updatedAt: '2026-08-01T09:10:00',
    };
    this.remoteStatus = createRemoteStatus({
      latestVersionId: NEW_VERSION_ID,
      latestVersionNumber: 2,
      onlineVersionId: NEW_VERSION_ID,
      onlineVersionNumber: 2,
      releaseUrl: record.task.releaseUrl,
      lastPublishedAt: '2026-08-01T09:10:00',
    });
    if (record.task.requestId === SUCCESS_REQUEST_ID) this.failNextStatus = true;
    this.sendSuccess(response, record.task);
  }

  handleCancel(response, body) {
    const record = this.tasks.get(String(body.id));
    if (!record) throw new Error(`未知待取消 taskId：${body.id}`);
    record.task = { ...record.task, status: 'CANCELED', stage: 'CANCELED', updatedAt: '2026-08-01T09:20:00' };
    this.sendSuccess(response, record.task);
  }

  toSessionResponse(session) {
    const uploadedChunks = [...session.uploadedChunks].sort((left, right) => left - right);
    const receivedBytes = uploadedChunks.reduce((total, chunkIndex) => {
      return total + Math.min(session.chunkSize, session.fileSize - chunkIndex * session.chunkSize);
    }, 0);
    assert.ok(Number.isSafeInteger(receivedBytes) && receivedBytes >= 0, JSON.stringify({
      uploadId: session.uploadId,
      fileSize: session.fileSize,
      chunkSize: session.chunkSize,
      uploadedChunks,
      receivedBytes,
    }));
    return {
      uploadId: session.uploadId,
      packageType: session.packageType,
      fileName: session.fileName,
      fileSize: session.fileSize,
      sha256: session.sha256,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      uploadedChunks,
      receivedBytes,
      status: session.status,
      completedFileId: session.completedFileId,
      expiresAt: '2026-08-02T09:00:00',
    };
  }

  getUploadedPackage(requestId, packageType) {
    const session = [...this.sessions.values()].find((item) => item.requestId === requestId && item.packageType === packageType);
    assert.ok(session, `${requestId} ${packageType} 上传会话缺失。`);
    assert.equal(session.status, 'COMPLETED');
    const chunks = [];
    for (let chunkIndex = 0; chunkIndex < session.totalChunks; chunkIndex += 1) {
      const chunk = session.chunkBodies?.get(chunkIndex);
      assert.ok(chunk, `${requestId} ${packageType} 分片 ${chunkIndex} 未被测试服务器捕获。`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async readRequestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  sendSuccess(response, data) {
    this.sendJson(response, { success: true, code: 'SUCCESS', message: 'ok', data });
  }

  sendJson(response, payload, status = 200) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(payload));
  }
}

async function expectFileMissing(filePath) {
  await assert.rejects(stat(filePath), (error) => error && error.code === 'ENOENT');
}

async function run() {
  const configuredTestRoot = process.env.ZENDING_DIGITAL_TWIN_PUBLISH_TEST_ROOT;
  if (!configuredTestRoot || !path.isAbsolute(configuredTestRoot)) {
    throw new Error('数字孪生发布集成测试必须由专用 runner 提供临时目录。');
  }
  const testRoot = path.resolve(configuredTestRoot);
  const userDataRoot = path.join(testRoot, 'user-data');
  const fakeAppRoot = path.join(testRoot, 'fake-app');
  const workspaceRoot = path.join(testRoot, 'workspace');
  const projectRoot = path.join(workspaceRoot, 'Projects', PROJECT_ID);
  const sharedResourcesRoot = path.join(workspaceRoot, 'SharedResources');
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const sceneContent = createSceneContent();
  const mock = new DigitalTwinMockServer();
  let originalGetAppPath = null;
  let clearCurrentDataPlatformBinding = () => undefined;
  let clearSharedProjectSkyboxRoot = () => undefined;

  try {
    await mkdir(userDataRoot, { recursive: true });
    await mkdir(path.join(fakeAppRoot, 'dist-viewer-template'), { recursive: true });
    await writeFile(path.join(fakeAppRoot, 'dist-viewer-template', 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>\n', 'utf8');
    app.setPath('userData', userDataRoot);

    originalGetAppPath = app.getAppPath.bind(app);
    app.getAppPath = () => fakeAppRoot;
    await mock.start();
    await writeFile(
      path.join(userDataRoot, 'data-platform-config.json'),
      `${JSON.stringify({ version: 2, baseUrl: mock.baseUrl, workspaceRoot }, null, 2)}
`,
      'utf8',
    );

    const bindingModule = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
    const transferModule = await import('../../dist-electron/ipc/dataPlatformTransfer.js');
    const uploadClientModule = await import('../../dist-electron/ipc/digitalTwinUploadClient.js');
    const projectAssetModule = await import('../../dist-electron/ipc/projectAssetStore.js');
    const deploymentSceneModule = await import('../../dist-electron/ipc/deploymentExportScene.js');
    const publishModule = await import('../../dist-electron/ipc/digitalTwinPublishService.js');
    clearCurrentDataPlatformBinding = bindingModule.clearCurrentDataPlatformBinding;
    clearSharedProjectSkyboxRoot = () => projectAssetModule.setSharedProjectSkyboxRoot(null);

    const baseOrigin = new URL(mock.baseUrl).origin;
    assert.equal(
      transferModule.resolveDataPlatformRemoteUrl(mock.baseUrl, 'api/v1/files/1').toString(),
      `${mock.baseUrl}/api/v1/files/1`,
    );
    assert.equal(
      transferModule.resolveDataPlatformRemoteUrl(mock.baseUrl, `${baseOrigin}/files/1.zip#download`).toString(),
      `${baseOrigin}/files/1.zip`,
    );
    assert.throws(
      () => transferModule.resolveDataPlatformRemoteUrl(mock.baseUrl, 'https://example.com/files/1.zip'),
      /必须与已配置服务地址同源/,
    );

    mock.resetRequests();
    await assert.rejects(
      transferModule.requestDataPlatformJson({
        baseUrl: mock.baseUrl,
        endpointPath: 'redirect-json',
        body: {},
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        context: '数据中台 JSON 重定向测试',
      }),
      (error) => error instanceof Error && error.name !== 'AbortError',
    );
    assert.equal(mock.requests.some((request) => request.path.endsWith('/redirect-target')), false, '数据中台 JSON 请求不应跟随重定向。');

    mock.resetRequests();
    const redirectDestination = path.join(testRoot, 'redirect-download.bin');
    await assert.rejects(
      transferModule.downloadRemoteFile({
        baseUrl: mock.baseUrl,
        remoteUrl: 'redirect-file',
        destinationPath: redirectDestination,
        maxBytes: 1024,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        context: '数据中台文件重定向测试',
      }),
      (error) => error instanceof Error && error.name !== 'AbortError',
    );
    await expectFileMissing(redirectDestination);
    assert.equal(mock.requests.some((request) => request.path.endsWith('/redirect-target')), false, '数据中台文件下载不应跟随重定向。');

    mock.redirectNextStatus = true;
    mock.resetRequests();
    const redirectClient = new uploadClientModule.DigitalTwinUploadClient(mock.baseUrl);
    await assert.rejects(
      redirectClient.projectStatus(PROJECT_ID, new AbortController().signal),
      (error) => error instanceof Error && error.name !== 'AbortError',
    );
    assert.ok(mock.requests.some((request) => request.path.endsWith('/digital-twin/projects/status')));
    assert.equal(mock.requests.some((request) => request.path.endsWith('/redirect-target')), false, '发布 API 不应跟随重定向。');

    const oversizedUploadId = mock.allocateId();
    mock.sessions.set(oversizedUploadId, {
      requestId: 'oversized-chunk-session',
      uploadId: oversizedUploadId,
      packageType: 'SOURCE',
      fileName: 'oversized.zip',
      fileSize: 1,
      sha256: 'a'.repeat(64),
      chunkSize: 64 * 1024 * 1024 + 1,
      totalChunks: 1,
      uploadedChunks: new Set(),
      completedFileId: null,
      status: 'UPLOADING',
      attempts: new Map(),
      chunkBodies: new Map(),
    });
    await assert.rejects(
      redirectClient.uploadDetail(oversizedUploadId, new AbortController().signal),
      /chunkSize 超过 64 MiB/,
    );

    mock.setRemoteStatus(createRemoteStatus({ projectId: '2054201280000000999' }));
    await assert.rejects(
      redirectClient.projectStatus(PROJECT_ID, new AbortController().signal),
      /状态响应与请求项目不匹配/,
    );
    mock.setRemoteStatus(createRemoteStatus());

    await assert.rejects(
      redirectClient.prepare({
        requestId: MISMATCHED_PREPARE_REQUEST_ID,
        projectId: PROJECT_ID,
        baseVersionId: BASE_VERSION_ID,
        overwriteExisting: true,
        forceOverwrite: false,
        publishName: '身份校验测试',
        remark: null,
        entryScenePath: 'Scenes/main.scene.json',
        entrySceneName: 'main',
        manifestJson: '{}',
        resourceRevision: RESOURCE_REVISION,
        confirmResourceBindings: false,
        modelIds: [],
        envModelIds: [],
        comboModelIds: [],
        sourcePackage: { fileName: 'source.zip', fileSize: 1, sha256: 'a'.repeat(64) },
        distPackage: { fileName: 'dist.zip', fileSize: 1, sha256: 'b'.repeat(64) },
      }, new AbortController().signal),
      /prepare 响应与原发布请求不匹配/,
    );

    await projectAssetModule.ensureProjectDirectories(projectRoot);
    await projectAssetModule.ensureProjectDirectories(sharedResourcesRoot);
    await mkdir(path.dirname(scenePath), { recursive: true });
    await writeFile(scenePath, sceneContent, 'utf8');
    await writeFile(
      path.join(projectRoot, '.babylon-editor', 'asset-index.json'),
      `${JSON.stringify({ version: 2, assets: [] }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(sharedResourcesRoot, '.babylon-editor', 'asset-index.json'),
      `${JSON.stringify({ version: 2, assets: [] }, null, 2)}\n`,
      'utf8',
    );
    await projectAssetModule.activateProjectRoot(projectRoot, scenePath);
    projectAssetModule.setSharedProjectAssetRoot(sharedResourcesRoot);

    const manualSkyboxRoot = path.join(workspaceRoot, 'ManualSkyboxCache');
    const primarySkyboxData = createHdrFixture('primary-remote', 41);
    const unusedSkyboxData = createHdrFixture('unused-remote', 52);
    const primarySkyboxPath = path.join(manualSkyboxRoot, 'Assets', 'Skyboxes', 'DataPlatform', `Skybox-${PRIMARY_SKYBOX_ID}`, 'skybox.hdr');
    const unusedSkyboxPath = path.join(manualSkyboxRoot, 'Assets', 'Skyboxes', 'DataPlatform', `Skybox-${UNUSED_SKYBOX_ID}`, 'skybox.hdr');
    await mkdir(path.dirname(primarySkyboxPath), { recursive: true });
    await mkdir(path.dirname(unusedSkyboxPath), { recursive: true });
    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeFile(unusedSkyboxPath, unusedSkyboxData);
    const createSkyboxEntries = (primaryStatus = 'active', primaryData = primarySkyboxData) => [
      createDataPlatformSkyboxEntry(PRIMARY_SKYBOX_ID, '晨曦天空', primaryData, primaryStatus),
      createDataPlatformSkyboxEntry(UNUSED_SKYBOX_ID, '未引用夜空', unusedSkyboxData),
    ];
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries());
    projectAssetModule.setSharedProjectSkyboxRoot(manualSkyboxRoot);

    async function resetBinding(overrides = {}) {
      const metadata = bindingModule.createDataPlatformBinding({
        baseUrl: mock.baseUrl,
        projectId: PROJECT_ID,
        projectName: '发布集成测试项目',
        editorProjectId: EDITOR_PROJECT_ID,
        latestVersionId: BASE_VERSION_ID,
        latestVersionNumber: 1,
        resourceRevision: RESOURCE_REVISION,
        entryScenePath: 'Scenes/main.scene.json',
        syncedAt: '2026-08-01T08:00:00.000Z',
        ...overrides,
      });
      await bindingModule.writeDataPlatformBinding(projectRoot, metadata);
      bindingModule.setCurrentDataPlatformBinding(projectRoot, metadata);
      projectAssetModule.setSharedProjectSkyboxRoot(manualSkyboxRoot);
      return metadata;
    }

    await resetBinding();
    bindingModule.clearCurrentDataPlatformBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const remoteContext = await publishModule.getDigitalTwinPublishContext();
    assert.equal(remoteContext.dataPlatformOrigin, new URL(mock.baseUrl).origin);
    assert.equal(bindingModule.getCurrentDataPlatformBinding()?.metadata.projectId, PROJECT_ID);
    assert.equal(projectAssetModule.getSharedProjectAssetRoot(), path.resolve(sharedResourcesRoot));
    assert.equal(projectAssetModule.getSharedProjectEnvironmentRoot(), path.resolve(sharedResourcesRoot));
    assert.equal(projectAssetModule.getSharedProjectSkyboxRoot(), path.resolve(sharedResourcesRoot));
    assert.deepEqual(remoteContext.allowedParentOrigins, [
      'https://existing.example.com',
      new URL(mock.baseUrl).origin,
    ]);
    await assert.rejects(
      publishModule.getDigitalTwinPublishContext(OTHER_PROJECT_ID),
      /不能在发布时切换项目/,
    );
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(BOUND_PROJECT_SWITCH_REQUEST_ID, sceneContent, { projectId: OTHER_PROJECT_ID }),
        new AbortController().signal,
        () => undefined,
      ),
      /不能在发布时切换项目/,
    );
    mock.resetRequests();
    const localActiveContext = publishModule.getLocalDigitalTwinPublishContext(true);
    assert.equal(localActiveContext.publishActive, true);
    assert.equal(localActiveContext.projectId, PROJECT_ID);
    assert.equal(localActiveContext.dataPlatformOrigin, new URL(mock.baseUrl).origin);
    assert.deepEqual(localActiveContext.allowedParentOrigins, [new URL(mock.baseUrl).origin]);
    assert.equal(mock.requests.length, 0, '本地发布活动状态不应访问网络。');

    await rm(bindingModule.getDataPlatformBindingPath(projectRoot), { force: true });
    bindingModule.clearCurrentDataPlatformBinding();
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(UNBOUND_NO_PROJECT_REQUEST_ID, sceneContent),
        new AbortController().signal,
        () => undefined,
      ),
      /请先选择发布项目/,
    );
    mock.projectDetailId = '2054201280000000999';
    mock.setRemoteStatus(createRemoteStatus({ projectId: mock.projectDetailId }));
    mock.resetRequests();
    await assert.rejects(
      publishModule.getDigitalTwinPublishContext(PROJECT_ID),
      /项目详情响应与请求项目不匹配/,
    );
    assert.equal(await bindingModule.readDataPlatformBinding(projectRoot), null);

    mock.projectDetailId = PROJECT_ID;
    mock.projectDetailOverrides = {
      latestEditorProjectId: null,
      latestEditorProjectVersionId: null,
      latestEditorProjectVersionNumber: null,
    };
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const selectedProjectContext = await publishModule.getDigitalTwinPublishContext(PROJECT_ID);
    assert.equal(selectedProjectContext.available, true);
    assert.equal(selectedProjectContext.projectId, PROJECT_ID);
    assert.equal(selectedProjectContext.projectName, '发布集成测试项目');
    assert.equal(selectedProjectContext.editorProjectId, EDITOR_PROJECT_ID);
    assert.equal(selectedProjectContext.baseVersionId, BASE_VERSION_ID);
    assert.equal(selectedProjectContext.versionConflict, false);
    const selectedProjectConfirmation = await publishModule.publishDigitalTwin(
      createPublishRequest(SELECTED_PROJECT_CONFIRM_REQUEST_ID, sceneContent, {
        projectId: PROJECT_ID,
        overwriteExisting: false,
      }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(selectedProjectConfirmation.status, 'confirmation-required');
    assert.equal(await bindingModule.readDataPlatformBinding(projectRoot), null, '确认覆盖前不应写入本地绑定。');
    assert.equal(bindingModule.getCurrentDataPlatformBinding(), null, '确认覆盖前不应激活当前绑定。');

    const selectedProjectResult = await publishModule.publishDigitalTwin(
      createPublishRequest(SELECTED_PROJECT_REQUEST_ID, sceneContent, {
        projectId: PROJECT_ID,
        overwriteExisting: true,
      }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(selectedProjectResult.status, 'completed');
    const selectedSourceEntries = await readZipEntries(mock.getUploadedPackage(SELECTED_PROJECT_REQUEST_ID, 'SOURCE'));
    const selectedSourceScene = JSON.parse(selectedSourceEntries.get('Scenes/main.scene.json').toString('utf8'));
    assert.deepEqual(selectedSourceScene.scene.fetchConfig, PUBLISHED_FETCH_CONFIG);
    const selectedDistEntries = await readZipEntries(mock.getUploadedPackage(SELECTED_PROJECT_REQUEST_ID, 'DIST'));
    const selectedDistScene = JSON.parse(selectedDistEntries.get('project/scene.json').toString('utf8'));
    assert.deepEqual(selectedDistScene.scene.fetchConfig, {
      url: PUBLISHED_FETCH_CONFIG.url,
      apiKey: '',
    });
    const selectedProjectBinding = await bindingModule.readDataPlatformBinding(projectRoot);
    assert.equal(selectedProjectBinding?.workspaceRoot, path.resolve(workspaceRoot));
    assert.equal(selectedProjectBinding?.projectId, PROJECT_ID);
    assert.equal(selectedProjectBinding?.projectName, '发布集成测试项目');
    assert.equal(bindingModule.getCurrentDataPlatformBinding()?.metadata.projectId, PROJECT_ID);

    mock.projectDetailOverrides = {};
    await resetBinding({ workspaceRoot });
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();

    const indexedSkyboxSceneContent = createDataPlatformSkyboxSceneContent(PRIMARY_SKYBOX_ID, mock.baseUrl);
    const expectedSkyboxPath = `project/assets/skyboxes/Skybox-${PRIMARY_SKYBOX_ID}/skybox.hdr`;
    const expectedSkyboxUrl = `editor-asset://local/${encodeURIComponent(expectedSkyboxPath)}`;
    const expectedSkyboxPackageUrl = `editor-asset://local/${encodeURIComponent(`project/assets/skyboxes/Skybox-${PRIMARY_SKYBOX_ID}/`)}`;
    const expectedSourceSkyboxPath = `Assets/Skyboxes/DataPlatform/Skybox-${PRIMARY_SKYBOX_ID}/skybox.hdr`;
    const expectedSourceSkyboxPackagePath = `Assets/Skyboxes/DataPlatform/Skybox-${PRIMARY_SKYBOX_ID}`;
    const expectedSourceSkyboxUrl = `editor-asset://local/${encodeURIComponent(expectedSourceSkyboxPath)}`;
    const assertOfflineSourceSkyboxPackage = (sourceEntries, label) => {
      const sourceSkyboxPaths = [...sourceEntries.keys()].filter((entryPath) => (
        entryPath.startsWith('Assets/Skyboxes/DataPlatform/') && /\.(?:hdr|exr)$/i.test(entryPath)
      ));
      assert.deepEqual(sourceSkyboxPaths, [expectedSourceSkyboxPath], `${label}只能包含实际引用的 SOURCE 天空盒。`);
      assert.deepEqual(sourceEntries.get(expectedSourceSkyboxPath), primarySkyboxData);
      assert.equal(sourceEntries.has(`Assets/Skyboxes/DataPlatform/Skybox-${UNUSED_SKYBOX_ID}/skybox.hdr`), false);
      const sourceScene = JSON.parse(sourceEntries.get('Scenes/main.scene.json').toString('utf8'));
      const sourceSettingsSkybox = sourceScene.scene.sceneSettings.skybox;
      const sourceEntitySkybox = sourceScene.scene.entities['skybox-reference'].components.skybox;
      for (const sourceSkybox of [sourceSettingsSkybox, sourceEntitySkybox]) {
        assert.equal(sourceSkybox.packagePath, expectedSourceSkyboxPackagePath);
        assert.equal(sourceSkybox.sourcePath, expectedSourceSkyboxPath);
        assert.equal(sourceSkybox.sourceUrl, expectedSourceSkyboxUrl);
        assert.equal(sourceSkybox.dataPlatformResourceId, PRIMARY_SKYBOX_ID);
      }
      assert.equal(JSON.stringify(sourceScene).includes(mock.baseUrl), false, `${label}场景不得保留数据中台天空盒 URL。`);
    };
    const prepareSkyboxScene = (content) => deploymentSceneModule.prepareDeploymentExport(
      content,
      '天空盒发布预检',
      [],
      new AbortController().signal,
      () => undefined,
    );
    const resetSkyboxPublishState = async () => {
      await resetBinding();
      mock.setRemoteStatus(createRemoteStatus());
      mock.resetRequests();
    };
    const assertCacheFailure = async (promise, statusLabel) => {
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          new RegExp(`数据中台天空盒“晨曦天空”（ID ${PRIMARY_SKYBOX_ID}）兼容缓存缺失：`),
          `${statusLabel}缓存失败应携带资源上下文。`,
        );
        assert.equal(error.message.includes(testRoot), false, '缓存错误不得泄漏测试机绝对路径。');
        assert.equal(error.message.includes(manualSkyboxRoot), false, '缓存错误不得泄漏共享缓存绝对路径。');
        return true;
      });
    };

    await resetSkyboxPublishState();
    const indexedSkyboxResult = await publishModule.publishDigitalTwin(
      createPublishRequest(INDEXED_SKYBOX_REQUEST_ID, indexedSkyboxSceneContent),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(indexedSkyboxResult.status, 'completed');
    const indexedSourceEntries = await readZipEntries(mock.getUploadedPackage(INDEXED_SKYBOX_REQUEST_ID, 'SOURCE'));
    assertOfflineSourceSkyboxPackage(indexedSourceEntries, 'SOURCE 发布包');
    const indexedDistEntries = await readZipEntries(mock.getUploadedPackage(INDEXED_SKYBOX_REQUEST_ID, 'DIST'));
    const packagedSkyboxPaths = [...indexedDistEntries.keys()].filter((entryPath) => (
      entryPath.startsWith('project/assets/skyboxes/') && /\.(?:hdr|exr)$/i.test(entryPath)
    ));
    assert.deepEqual(packagedSkyboxPaths, [expectedSkyboxPath], '发布包只能包含场景实际引用的天空盒。');
    assert.deepEqual(indexedDistEntries.get(expectedSkyboxPath), primarySkyboxData);
    assert.equal(indexedDistEntries.has(`project/assets/skyboxes/Skybox-${UNUSED_SKYBOX_ID}/skybox.hdr`), false);
    const packagedSkyboxScene = JSON.parse(indexedDistEntries.get('project/scene.json').toString('utf8'));
    const packagedSettingsSkybox = packagedSkyboxScene.scene.sceneSettings.skybox;
    const packagedEntitySkybox = packagedSkyboxScene.scene.entities['skybox-reference'].components.skybox;
    for (const packagedSkybox of [packagedSettingsSkybox, packagedEntitySkybox]) {
      assert.equal(packagedSkybox.packagePath, expectedSkyboxPackageUrl);
      assert.equal(packagedSkybox.sourcePath, expectedSkyboxUrl);
      assert.equal(packagedSkybox.sourceUrl, expectedSkyboxUrl);
      assert.equal(packagedSkybox.dataPlatformResourceId, PRIMARY_SKYBOX_ID);
    }
    const packagedManifest = JSON.parse(indexedDistEntries.get('project/asset-manifest.json').toString('utf8'));
    assert.deepEqual(
      packagedManifest.assets.filter((asset) => asset.path.startsWith('./skyboxes/')).map((asset) => asset.path),
      [`./skyboxes/Skybox-${PRIMARY_SKYBOX_ID}/skybox.hdr`],
    );
    const viewerText = [...indexedDistEntries.entries()]
      .filter(([entryPath]) => /\.(?:html|js|css|json|md)$/i.test(entryPath))
      .map(([, data]) => data.toString('utf8'))
      .join('\n');
    assert.equal(viewerText.includes(mock.baseUrl), false, 'Viewer 产物不得保留数据中台天空盒 URL。');

    const toctouSkyboxData = createHdrFixture('primary-remote', 63);
    assert.equal(toctouSkyboxData.length, primarySkyboxData.length);
    const createStableSkyboxSnapshot = async () => {
      const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(primarySkyboxPath, fixedTime, fixedTime);
      return stat(primarySkyboxPath);
    };
    const overwriteSkyboxPreservingSnapshot = (snapshot) => {
      writeFileSync(primarySkyboxPath, toctouSkyboxData);
      utimesSync(primarySkyboxPath, snapshot.atime, snapshot.mtime);
      const replacedStat = statSync(primarySkyboxPath);
      assert.equal(replacedStat.size, snapshot.size);
      assert.equal(replacedStat.mtimeMs, snapshot.mtimeMs, 'TOCTOU 测试必须保持预检 mtime 快照。');
    };

    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    await resetSkyboxPublishState();
    const sourceSnapshot = await createStableSkyboxSnapshot();
    const sourceToctouPhases = [];
    let sourceReplaced = false;
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(SOURCE_SKYBOX_TOCTOU_REQUEST_ID, indexedSkyboxSceneContent),
        new AbortController().signal,
        (progress) => {
          sourceToctouPhases.push(progress.phase);
          if (!sourceReplaced && progress.phase === 'source-package' && progress.detail === '正在复制源工程场景…') {
            sourceReplaced = true;
            overwriteSkyboxPreservingSnapshot(sourceSnapshot);
          }
        },
      ),
      /SHA-256|完整性|最终复制/,
    );
    assert.equal(sourceReplaced, true);
    assert.equal(sourceToctouPhases.includes('dist-package'), false, 'SOURCE 最终复制校验必须先于 DIST 构建失败。');
    assert.equal(mock.requests.some((request) => request.path.endsWith('/publish-tasks/prepare')), false);
    await expectFileMissing(path.join(app.getPath('temp'), 'zending-digital-twin-publish', SOURCE_SKYBOX_TOCTOU_REQUEST_ID));

    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    await resetSkyboxPublishState();
    const distSnapshot = await createStableSkyboxSnapshot();
    let distReplaced = false;
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(DIST_SKYBOX_TOCTOU_REQUEST_ID, indexedSkyboxSceneContent),
        new AbortController().signal,
        (progress) => {
          if (!distReplaced && progress.phase === 'dist-package' && progress.detail === '正在复制场景资源并计算哈希…') {
            distReplaced = true;
            overwriteSkyboxPreservingSnapshot(distSnapshot);
          }
        },
      ),
      /SHA-256|完整性|最终复制/,
    );
    assert.equal(distReplaced, true);
    assert.equal(mock.requests.some((request) => request.path.endsWith('/publish-tasks/prepare')), false);
    await expectFileMissing(path.join(app.getPath('temp'), 'zending-digital-twin-publish', DIST_SKYBOX_TOCTOU_REQUEST_ID));

    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('orphaned'));
    await resetSkyboxPublishState();
    const orphanedSkyboxResult = await publishModule.publishDigitalTwin(
      createPublishRequest(ORPHANED_SKYBOX_REQUEST_ID, indexedSkyboxSceneContent),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(orphanedSkyboxResult.status, 'completed');
    const orphanedSkyboxWarning = `数据中台天空盒“晨曦天空”（ID ${PRIMARY_SKYBOX_ID}）已删除，发布包将使用本地兼容缓存。`;
    assert.ok(orphanedSkyboxResult.warnings.includes(orphanedSkyboxWarning));
    assert.equal(
      orphanedSkyboxResult.warnings.filter((warning) => warning === orphanedSkyboxWarning).length,
      1,
      '同一天空盒重复引用只能产生一条 orphaned 警告。',
    );

    await rm(primarySkyboxPath, { force: true });
    await assertCacheFailure(prepareSkyboxScene(indexedSkyboxSceneContent), 'orphaned');

    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    await assertCacheFailure(prepareSkyboxScene(indexedSkyboxSceneContent), 'active');

    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeFile(
      path.join(manualSkyboxRoot, '.babylon-editor', 'data-platform-skybox-index.json'),
      '{"version":1,"entries":[',
      'utf8',
    );
    await assert.rejects(prepareSkyboxScene(indexedSkyboxSceneContent), /天空盒索引 JSON 已损坏/);

    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    await assert.rejects(
      prepareSkyboxScene(createDataPlatformSkyboxSceneContent('01', mock.baseUrl)),
      /dataPlatformResourceId.*1-64/,
    );

    const corruptSkyboxData = createCorruptHdrFixture();
    await writeFile(primarySkyboxPath, corruptSkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active', corruptSkyboxData));
    await assertCacheFailure(prepareSkyboxScene(indexedSkyboxSceneContent), '损坏');

    const mismatchedSkyboxData = createHdrFixture('primary-remote', 61);
    assert.equal(mismatchedSkyboxData.length, primarySkyboxData.length);
    await writeFile(primarySkyboxPath, mismatchedSkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    await assertCacheFailure(prepareSkyboxScene(indexedSkyboxSceneContent), 'SHA-256 不一致');

    await writeFile(primarySkyboxPath, primarySkyboxData);
    await writeDataPlatformSkyboxIndex(manualSkyboxRoot, createSkyboxEntries('active'));
    const localSkyboxPath = path.join(projectRoot, 'Assets', 'Skyboxes', 'LocalCompatibility', 'skybox.hdr');
    await mkdir(path.dirname(localSkyboxPath), { recursive: true });
    await writeFile(localSkyboxPath, createHdrFixture('local-compatibility', 35));
    const localPrepared = await prepareSkyboxScene(createLocalSkyboxSceneContent(localSkyboxPath));
    assert.equal(localPrepared.assetFiles.filter((file) => /skybox\.hdr$/i.test(file.destinationRelativePath)).length, 1);

    const originalJsonParse = JSON.parse;
    try {
      let accessorGetterCalls = 0;
      const accessorScene = originalJsonParse(indexedSkyboxSceneContent);
      const accessorSkybox = accessorScene.scene.sceneSettings.skybox;
      delete accessorSkybox.dataPlatformResourceId;
      Object.defineProperty(accessorSkybox, 'dataPlatformResourceId', {
        enumerable: true,
        configurable: true,
        get() {
          accessorGetterCalls += 1;
          return PRIMARY_SKYBOX_ID;
        },
      });
      JSON.parse = (content, ...args) => content === '__ACCESSOR_SKYBOX_SCENE__'
        ? accessorScene
        : originalJsonParse(content, ...args);
      await assert.rejects(prepareSkyboxScene('__ACCESSOR_SKYBOX_SCENE__'), /dataPlatformResourceId/);
      assert.equal(accessorGetterCalls, 0, '发布预检不得执行 dataPlatformResourceId getter。');

      let inheritedGetterCalls = 0;
      const inheritedScene = originalJsonParse(indexedSkyboxSceneContent);
      const inheritedSource = inheritedScene.scene.sceneSettings.skybox;
      const inheritedPrototype = {};
      Object.defineProperty(inheritedPrototype, 'dataPlatformResourceId', {
        enumerable: true,
        configurable: true,
        get() {
          inheritedGetterCalls += 1;
          return PRIMARY_SKYBOX_ID;
        },
      });
      delete inheritedSource.dataPlatformResourceId;
      const inheritedSkybox = Object.assign(Object.create(inheritedPrototype), inheritedSource);
      inheritedScene.scene.sceneSettings.skybox = inheritedSkybox;
      JSON.parse = (content, ...args) => content === '__INHERITED_SKYBOX_SCENE__'
        ? inheritedScene
        : originalJsonParse(content, ...args);
      await assert.rejects(prepareSkyboxScene('__INHERITED_SKYBOX_SCENE__'), /dataPlatformResourceId/);
      assert.equal(inheritedGetterCalls, 0, '发布预检不得执行继承的 dataPlatformResourceId getter。');
    } finally {
      JSON.parse = originalJsonParse;
    }

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const overwriteResult = await publishModule.publishDigitalTwin(
      createPublishRequest('overwrite-confirm-required', sceneContent, { overwriteExisting: false }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(overwriteResult.status, 'confirmation-required');
    assert.equal(overwriteResult.errorCode, 'DIGITAL_TWIN_OVERWRITE_CONFIRM_REQUIRED');
    assert.match(overwriteResult.message, /已经有当前数字孪生工程/);
    assert.equal(mock.requests.some((request) => request.path.endsWith('/publish-tasks/prepare')), false);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.failNextRuntimeConfigSave = true;
    mock.resetRequests();
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(RUNTIME_CONFIG_FAILURE_REQUEST_ID, sceneContent),
        new AbortController().signal,
        () => undefined,
      ),
      /模拟运行配置保存失败/,
    );
    assert.equal(mock.requests.some((request) => request.path.endsWith('/publish-tasks/prepare')), false);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const successProgress = [];
    const successResult = await publishModule.publishDigitalTwin(
      createPublishRequest(SUCCESS_REQUEST_ID, sceneContent, { confirmResourceBindings: true }),
      new AbortController().signal,
      (progress) => successProgress.push(progress),
    );
    assert.equal(successResult.status, 'completed');
    assert.equal(successResult.editorProjectId, EDITOR_PROJECT_ID);
    assert.equal(successResult.editorProjectVersionId, NEW_VERSION_ID);
    assert.equal(successResult.editorProjectVersionNumber, 2);
    assert.match(successResult.stableUrl, /\/digital-twin\/projects\//);
    assert.match(successResult.releaseUrl, /\/digital-twin\/releases\//);
    assert.ok(successResult.warnings.some((warning) => warning.includes('CAD 参考图')));
    assert.ok(successResult.warnings.some((warning) => warning.includes('刷新远端项目状态失败')));
    for (const phase of ['saving', 'source-package', 'dist-package', 'prepare', 'upload-source', 'upload-dist', 'commit', 'completed']) {
      assert.ok(successProgress.some((progress) => progress.phase === phase), `缺少发布进度阶段：${phase}`);
    }
    const runtimeConfigSave = mock.requests.find((request) => request.path.endsWith('/runtime-config/save'));
    assert.ok(runtimeConfigSave, '发布前应保存父页面 Origin。');
    assert.equal(runtimeConfigSave.body.projectId, PROJECT_ID);
    assert.equal(runtimeConfigSave.body.mqttBrokerUrl, 'ws://broker.internal:8083/mqtt');
    assert.equal(runtimeConfigSave.body.apiBaseUrl, 'https://api.internal/runtime');
    assert.equal(runtimeConfigSave.body.runtimeEnabled, false);
    assert.deepEqual(JSON.parse(runtimeConfigSave.body.configJson), {
      telemetryInterval: 1000,
      integration: {
        futureField: true,
        allowedParentOrigins: PUBLISH_PARENT_ORIGINS,
      },
    });
    const runtimeConfigSaveIndex = mock.requests.indexOf(runtimeConfigSave);
    const prepareIndex = mock.requests.findIndex((request) => (
      request.path.endsWith('/publish-tasks/prepare') && request.body.requestId === SUCCESS_REQUEST_ID
    ));
    assert.ok(runtimeConfigSaveIndex >= 0 && runtimeConfigSaveIndex < prepareIndex, '运行配置必须先于发布任务保存。');

    const successPrepare = mock.requests.find((request) => (
      request.path.endsWith('/publish-tasks/prepare') && request.body.requestId === SUCCESS_REQUEST_ID
    ));
    assert.ok(successPrepare);
    assert.equal(successPrepare.body.overwriteExisting, true);
    assert.equal(successPrepare.body.forceOverwrite, false);
    assert.equal(successPrepare.body.confirmResourceBindings, true);
    assert.equal(successPrepare.body.projectId, PROJECT_ID);
    assert.equal(successPrepare.body.baseVersionId, BASE_VERSION_ID);
    assert.equal(successPrepare.body.resourceRevision, RESOURCE_REVISION);
    assert.deepEqual(successPrepare.body.modelIds, []);
    assert.deepEqual(successPrepare.body.envModelIds, []);
    assert.deepEqual(successPrepare.body.comboModelIds, []);
    assert.ok(successPrepare.body.sourcePackage.fileName.endsWith('.zip'));
    assert.ok(successPrepare.body.distPackage.fileName.endsWith('.zip'));
    assert.equal(mock.requests.some((request) => request.headers.authorization), false, '可信内网发布不应附带鉴权头。');
    for (const packageType of ['SOURCE', 'DIST']) {
      const session = [...mock.sessions.values()].find((item) => item.requestId === SUCCESS_REQUEST_ID && item.packageType === packageType);
      assert.ok(session, `${packageType} 上传会话缺失。`);
      const putRequests = mock.requests.filter((request) => request.path.includes(`/uploads/${session.uploadId}/chunks/`));
      assert.ok(putRequests.length > 0, `${packageType} 未上传任何待续传分片。`);
      assert.equal(putRequests.some((request) => request.path.endsWith('/chunks/0')), false, `${packageType} 已上传分片 0 不应重复发送。`);
      assert.ok(mock.requests.some((request) => request.path.endsWith(`/uploads/${session.uploadId}/complete`)), `${packageType} 未调用 complete。`);
      assert.equal(session.status, 'COMPLETED');
    }
    const successSource = [...mock.sessions.values()].find((item) => item.requestId === SUCCESS_REQUEST_ID && item.packageType === 'SOURCE');
    assert.equal(successSource.attempts.get(1), 2, 'SOURCE 临时失败分片应有限重试一次后成功。');
    const commitRequest = mock.requests.find((request) => request.path.endsWith('/publish-tasks/commit'));
    assert.ok(commitRequest);
    assert.equal(typeof commitRequest.body.taskId, 'string');
    const persistedAfterSuccess = await bindingModule.readDataPlatformBinding(projectRoot);
    assert.equal(persistedAfterSuccess.latestVersionId, NEW_VERSION_ID);
    assert.equal(persistedAfterSuccess.latestVersionNumber, 2);
    assert.equal(persistedAfterSuccess.resourceRevision, NEW_RESOURCE_REVISION);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const missingResult = await publishModule.publishDigitalTwin(
      createPublishRequest(MISSING_CONFIRM_REQUEST_ID, sceneContent),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(missingResult.status, 'confirmation-required');
    assert.equal(missingResult.errorCode, 'DIGITAL_TWIN_RESOURCE_BINDING_CONFIRM_REQUIRED');
    assert.deepEqual(missingResult.errorData, {
      missingModelIds: ['101'],
      missingEnvModelIds: [],
      missingComboModelIds: [],
    });
    const missingPrepare = mock.requests.find((request) => request.path.endsWith('/publish-tasks/prepare'));
    assert.equal(missingPrepare.body.confirmResourceBindings, false);
    assert.equal(mock.requests.some((request) => request.path.includes('/chunks/')), false);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus({ latestVersionId: NEW_VERSION_ID, latestVersionNumber: 2 }));
    mock.resetRequests();
    const versionConflictResult = await publishModule.publishDigitalTwin(
      createPublishRequest(VERSION_CONFLICT_REQUEST_ID, indexedSkyboxSceneContent),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(versionConflictResult.status, 'conflict');
    assert.equal(versionConflictResult.errorCode, 'DIGITAL_TWIN_VERSION_CONFLICT');
    assert.ok(versionConflictResult.conflictCopyPath);
    assert.ok(versionConflictResult.conflictCopyPath.startsWith(path.join(workspaceRoot, 'Conflicts', PROJECT_ID)));
    assert.equal((await readFile(versionConflictResult.conflictCopyPath)).subarray(0, 2).toString('ascii'), 'PK');
    const versionConflictEntries = await readZipFileEntries(versionConflictResult.conflictCopyPath);
    assertOfflineSourceSkyboxPackage(versionConflictEntries, '版本冲突副本');
    assert.equal(mock.requests.some((request) => request.path.endsWith('/runtime-config/save')), false);
    assert.equal(mock.requests.some((request) => request.path.endsWith('/publish-tasks/prepare')), false);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus({ latestVersionId: NEW_VERSION_ID, latestVersionNumber: 2 }));
    mock.resetRequests();
    const forceOverwriteResult = await publishModule.publishDigitalTwin(
      createPublishRequest(FORCE_OVERWRITE_REQUEST_ID, sceneContent, { forceOverwrite: true }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(forceOverwriteResult.status, 'completed');
    const forceOverwritePrepare = mock.requests.find((request) => (
      request.path.endsWith('/publish-tasks/prepare') && request.body.requestId === FORCE_OVERWRITE_REQUEST_ID
    ));
    assert.ok(forceOverwritePrepare);
    assert.equal(forceOverwritePrepare.body.forceOverwrite, true);
    assert.equal(forceOverwritePrepare.body.baseVersionId, BASE_VERSION_ID);
    const forceOverwriteTask = [...mock.tasks.values()].find((record) => (
      record.task.requestId === FORCE_OVERWRITE_REQUEST_ID
    ));
    assert.equal(forceOverwriteTask.task.baseVersionId, NEW_VERSION_ID);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const resourceConflictResult = await publishModule.publishDigitalTwin(
      createPublishRequest(RESOURCE_CONFLICT_REQUEST_ID, sceneContent, { forceOverwrite: true }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(resourceConflictResult.status, 'conflict');
    assert.equal(resourceConflictResult.errorCode, 'DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT');
    assert.deepEqual(resourceConflictResult.errorData, {
      expectedRevision: RESOURCE_REVISION,
      actualRevision: NEW_RESOURCE_REVISION,
    });
    assert.ok(resourceConflictResult.conflictCopyPath);
    assert.equal((await readFile(resourceConflictResult.conflictCopyPath)).subarray(0, 2).toString('ascii'), 'PK');
    const resourceConflictPrepare = mock.requests.find((request) => request.path.endsWith('/publish-tasks/prepare'));
    assert.equal(resourceConflictPrepare.body.forceOverwrite, true);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const commitConflictResult = await publishModule.publishDigitalTwin(
      createPublishRequest(COMMIT_CONFLICT_REQUEST_ID, sceneContent, { forceOverwrite: true }),
      new AbortController().signal,
      () => undefined,
    );
    assert.equal(commitConflictResult.status, 'conflict');
    assert.equal(commitConflictResult.errorCode, 'DIGITAL_TWIN_VERSION_CONFLICT');
    assert.deepEqual(commitConflictResult.errorData, { latestVersionId: NEW_VERSION_ID });
    assert.ok(commitConflictResult.conflictCopyPath);
    assert.equal((await readFile(commitConflictResult.conflictCopyPath)).subarray(0, 2).toString('ascii'), 'PK');
    assert.ok(mock.requests.some((request) => request.path.endsWith('/publish-tasks/commit')));
    const commitConflictPrepare = mock.requests.find((request) => request.path.endsWith('/publish-tasks/prepare'));
    assert.equal(commitConflictPrepare.body.forceOverwrite, true);

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    await assert.rejects(
      publishModule.publishDigitalTwin(
        createPublishRequest(UPLOAD_FAILURE_REQUEST_ID, sceneContent),
        new AbortController().signal,
        () => undefined,
      ),
      /永久上传失败/,
    );
    const failedChunkRequests = mock.requests.filter((request) => request.path.includes('/chunks/'));
    assert.equal(failedChunkRequests.length, 4, '永久分片错误应在有限重试后停止。');
    assert.ok(mock.requests.some((request) => request.path.endsWith('/publish-tasks/cancel')));
    await expectFileMissing(path.join(app.getPath('temp'), 'zending-digital-twin-publish', UPLOAD_FAILURE_REQUEST_ID));

    await resetBinding();
    mock.setRemoteStatus(createRemoteStatus());
    mock.resetRequests();
    const cancelController = new AbortController();
    const cancelProgress = [];
    const cancelPromise = publishModule.publishDigitalTwin(
      createPublishRequest(CANCEL_REQUEST_ID, sceneContent),
      cancelController.signal,
      (progress) => cancelProgress.push(progress),
    );
    await mock.waitForCancelChunkStart();
    cancelController.abort();
    const cancelResult = await cancelPromise;
    mock.releaseDelayedCancelChunk();
    assert.equal(cancelResult.status, 'canceled');
    assert.ok(cancelProgress.some((progress) => progress.phase === 'canceled'));
    const cancelRequest = mock.requests.find((request) => request.path.endsWith('/publish-tasks/cancel'));
    assert.ok(cancelRequest);
    assert.equal(typeof cancelRequest.body.id, 'string');
    await expectFileMissing(path.join(app.getPath('temp'), 'zending-digital-twin-publish', CANCEL_REQUEST_ID));

    assert.equal(sha256(await readFile(scenePath)), sha256(Buffer.from(sceneContent)), '发布保存后的入口场景内容应稳定。');
    console.log(JSON.stringify({
      status: 'PASS',
      verified: [
        'publish-context-restores-persisted-binding',
        'publish-context-default-parent-origin',
        'bound-scene-project-switch-rejected',
        'unbound-scene-project-required',
        'unbound-scene-uses-current-remote-version',
        'unbound-scene-project-detail-identity',
        'unbound-scene-overwrite-confirmation-before-binding',
        'unbound-scene-project-selection-and-binding',
        'fetch-config-published-with-public-dist-api-key-stripped',
        'runtime-config-save-before-publish',
        'runtime-config-save-failure-blocks-publish',
        'version-conflict-does-not-change-runtime-config',
        'local-active-state-without-network',
        'overwrite-confirmation',
        'prepare-source-dist',
        'skip-missing-cad',
        'resume-uploaded-chunks',
        'transient-chunk-retry',
        'permanent-upload-failure-cancel',
        'complete-source-dist',
        'commit-and-binding-refresh',
        'post-commit-status-refresh-fallback',
        'missing-resource-binding-confirmation',
        'version-conflict-copy',
        'force-version-overwrite',
        'force-overwrite-resource-revision-conflict',
        'force-overwrite-commit-version-conflict',
        'resource-revision-conflict-copy',
        'commit-version-conflict-copy',
        'cancel-remote-task',
        'no-auth-header',
        'lossless-long-identifiers',
        'same-origin-remote-url',
        'data-platform-json-redirect-rejected',
        'data-platform-download-redirect-rejected',
        'publish-api-redirect-rejected',
        'oversized-upload-chunk-rejected',
        'project-status-identity-mismatch-rejected',
        'prepare-task-identity-mismatch-rejected',
        'indexed-skybox-offline-package',
        'indexed-skybox-source-offline-package',
        'indexed-skybox-conflict-copy-offline',
        'source-skybox-final-copy-integrity',
        'dist-skybox-final-copy-integrity',
        'indexed-skybox-reference-deduplication',
        'unreferenced-indexed-skybox-excluded',
        'orphaned-skybox-cache-warning',
        'indexed-skybox-cache-context-errors',
        'corrupt-skybox-index-rejected',
        'stable-skybox-id-own-data-validation',
        'local-skybox-publish-regression',
      ],
    }, null, 2));
  } finally {
    clearSharedProjectSkyboxRoot();
    clearCurrentDataPlatformBinding();
    await mock.close().catch(() => undefined);
    if (originalGetAppPath) app.getAppPath = originalGetAppPath;
  }
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    console.error('[digital-twin-publish-integration]', error);
    app.exit(1);
  },
);
