import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSceneOpenReadOnlyManifest } from '../../scripts/lib/sceneOpenManifestPrepare.mjs';

const projectId = '2071816469849280514', modelId = '90071992547409931', versionId = '90071992547409933';
function fixture(change = () => {}) {
  const calls = []; let statuses = 0;
  const model = { id: modelId, modelName: '真实模型', fileUrl: '/api/v1/files/m.glb', metaFileUrl: '/api/v1/files/meta.json',
    fileSha256: 'a'.repeat(64), metaFileSha256: 'b'.repeat(64), revision: '90071992547409939', scriptFiles: [{ fileUrl: '/api/v1/files/code.ts', fileSha256: 'c'.repeat(64) }] };
  const query = async (endpoint, body) => {
    calls.push({ endpoint, body }); let data;
    if (endpoint === 'api/v1/projects/detail') data = { id: projectId, projectName: '真实383', currentResourceRevision: '90071992547409937' };
    else if (endpoint === 'api/v1/digital-twin/projects/status') { statuses++; data = { projectId, editorProjectId: '90071992547409935', latestVersionId: versionId,
      latestVersionNumber: 1, status: 'DRAFT', runtimeConfig: { projectId, runtimeEnabled: false } }; }
    else if (endpoint === 'api/v1/models/detail') data = structuredClone(model);
    else if (endpoint === 'api/v1/env-models/sync-manifest/query') data = { protocolVersion: '1', manifestRevision: '90071992547409941', records: [], nextCursorId: null, hasMore: false };
    else {
      const records = endpoint === 'api/v1/models/query' ? [structuredClone(model)] : endpoint === 'api/v1/projects/query'
        ? [{ id: projectId, projectName: '真实383' }] : endpoint.includes('/config/screens/query')
          ? [{ screenId: '90071992547409943', screenName: '未交互大屏', thumbnailUrl: '/api/v1/files/screen.png' }] : [];
      // 后端BigscreenIconAppService.java:348-352的一手合同：icons请求200、返回effective100。
      data = { records, total: records.length, pageNum: body.pageNum, pageSize: endpoint === 'api/v1/bigscreen-icons/query' ? 100 : body.pageSize };
    }
    change({ endpoint, body, data, statuses }); return { success: true, data };
  };
  return { calls, query };
}
const options = query => ({ baseUrl: 'http://172.16.3.27:38087', projectId, inputSceneSha256: 'd'.repeat(64),
  inputModelResources: [{ kind: 'model', resourceId: modelId }], query });

test('显式前置仅已核POST；大ID/修订精确保留，SOURCE与资源都NOT_BYTE_VERIFIED', async () => {
  const f = fixture(), manifest = await prepareSceneOpenReadOnlyManifest(options(f.query));
  assert.equal(manifest.status, 'TRUSTED_METADATA_NOT_DOWNLOADED_NOT_BYTE_VERIFIED'); assert.equal(manifest.projectId, projectId);
  assert.equal(manifest.project.source.versionId, versionId); assert.equal(manifest.actualBytesVerified, false); assert.equal(manifest.sourceActualSha256, null);
  assert.ok(f.calls.every(row => row.endpoint.endsWith('/query') || row.endpoint.endsWith('/detail') || row.endpoint.endsWith('/status')));
  assert.ok(manifest.downloads.every(row => row.actualSha256 === null && row.byteVerification === 'NOT_DOWNLOADED_NOT_BYTE_VERIFIED'));
  assert.equal(manifest.downloads.find(row => row.role === 'metadata').declaredSha256, 'b'.repeat(64));
  assert.equal(manifest.downloads.find(row => row.role === 'script').declaredSha256, 'c'.repeat(64));
  assert.ok(manifest.downloads.some(row => row.role === 'screen-thumbnail'));
});

test('401、缺SOURCE、数值ID、危险URL或版本漂移直接保留失败，不猜旧包/新版', async () => {
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(async () => { throw new Error('HTTP 401'); })), /401/);
  const missing = fixture(({ endpoint, data }) => { if (endpoint.endsWith('/status')) { data.latestVersionId = null; data.status = 'UNBOUND'; } });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(missing.query)), /缺SOURCE/);
  const numeric = fixture(({ endpoint, data }) => { if (endpoint === 'api/v1/projects/detail') data.id = 42; });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(numeric.query)), /精确十进制字符串/);
  const missingRevision = fixture(({ endpoint, data }) => { if (endpoint === 'api/v1/projects/detail') delete data.currentResourceRevision; });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(missingRevision.query)), /resourceRevision必须有明确string/);
  const url = fixture(({ endpoint, data }) => { if (endpoint === 'api/v1/models/detail') data.fileUrl = 'javascript:bad'; });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(url.query)), /URL漂移|下载URL/);
  const drift = fixture(({ endpoint, data, statuses }) => { if (endpoint.endsWith('/status') && statuses > 1) data.latestVersionId = '90071992547409945'; });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(drift.query)), /观察不一致/);
});

test('同URL可有多个合法owner；具体SHA冲突不能借共享文件隐藏', async () => {
  const f = fixture(({ endpoint, data }) => {
    if (endpoint === 'api/v1/models/query') { const clone = structuredClone(data.records[0]); clone.id = '90071992547409947'; clone.revision = 'other-revision'; data.records.push(clone); data.total = 2; }
  });
  const manifest = await prepareSceneOpenReadOnlyManifest(options(f.query)); assert.ok(manifest.downloads.find(row => row.role === 'model').owners.length === 2);
  const bad = fixture(({ endpoint, data }) => {
    if (endpoint === 'api/v1/models/query') { const clone = structuredClone(data.records[0]); clone.id = '90071992547409947'; clone.fileSha256 = 'e'.repeat(64); data.records.push(clone); data.total = 2; }
  });
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(bad.query)), /SHA声明冲突/);
});

test('icons只接受已证明200→100 clamp，按实际100完整遍历201条并冻结各页ID/total/页号', async () => {
  const all = Array.from({length:201},(_,index)=>({id:(90071992547410000n+BigInt(index)).toString(),iconSource:'CUSTOM',iconType:'IMAGE',status:'ACTIVE',iconUrl:'/api/v1/files/icon-'+index+'.png'}));
  const f = fixture(({endpoint,body,data})=>{
    if(endpoint!=='api/v1/bigscreen-icons/query')return;
    data.records=all.slice((body.pageNum-1)*100,body.pageNum*100);data.total='201';data.pageSize='100';data.pageNum=String(body.pageNum);
  });
  const manifest=await prepareSceneOpenReadOnlyManifest(options(f.query));
  assert.deepEqual(f.calls.filter(row=>row.endpoint==='api/v1/bigscreen-icons/query').map(row=>[row.body.pageNum,row.body.pageSize]),[[1,200],[2,200],[3,200],[1,200],[2,200],[3,200]]);
  const pagination=manifest.pagination[0];assert.equal(pagination.requestedPageSize,200);assert.equal(pagination.effectivePageSize,100);assert.equal(pagination.total,201);
  assert.deepEqual(pagination.pages.map(row=>row.recordCount),[100,100,1]);assert.deepEqual(pagination.pages.flatMap(row=>row.ids),all.map(row=>row.id));
});

test('icons未知50/200/缺失effective、101条、页号/total/ID/两轮漂移仍拒绝', async () => {
  for(const invalid of [50,200,undefined]) {
    const f=fixture(({endpoint,data})=>{if(endpoint==='api/v1/bigscreen-icons/query'){if(invalid===undefined)delete data.pageSize;else data.pageSize=invalid;}});
    await assert.rejects(prepareSceneOpenReadOnlyManifest(options(f.query)),/effective pageSize|计数无效/);
  }
  const tooMany=fixture(({endpoint,data})=>{if(endpoint==='api/v1/bigscreen-icons/query'){data.records=Array.from({length:101},(_,i)=>({id:String(i+1)}));data.total=101;}});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(tooMany.query)),/records超过/);
  const wrongPage=fixture(({endpoint,data})=>{if(endpoint==='api/v1/bigscreen-icons/query')data.pageNum=2;});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(wrongPage.query)),/strictly equal/);
  const duplicates=fixture(({endpoint,data})=>{if(endpoint==='api/v1/bigscreen-icons/query'){data.records=[{id:'1'},{id:'1'}];data.total=2;}});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(duplicates.query)),/分页重复ID/);
  const drift=fixture(({endpoint,data,statuses})=>{if(endpoint==='api/v1/bigscreen-icons/query'&&statuses>1)data.total=1;});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(drift.query)),/分页提前结束/);
  const earlyEmpty=fixture(({endpoint,body,data})=>{if(endpoint==='api/v1/bigscreen-icons/query'){data.records=body.pageNum===1?Array.from({length:100},(_,i)=>({id:String(i+1)})):[];data.total=101;}});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(earlyEmpty.query)),/分页提前结束/);
  const totalDrift=fixture(({endpoint,body,data})=>{if(endpoint==='api/v1/bigscreen-icons/query'){data.records=Array.from({length:100},(_,i)=>({id:String((body.pageNum-1)*100+i+1)}));data.total=body.pageNum===1?201:202;}});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(totalDrift.query)),/分页total漂移/);
  const idDrift=fixture(({endpoint,data,statuses})=>{if(endpoint==='api/v1/bigscreen-icons/query'){data.records=[{id:statuses>1?'2':'1'}];data.total=1;}});
  await assert.rejects(prepareSceneOpenReadOnlyManifest(options(idDrift.query)),/两次元数据观察不一致/);
});
