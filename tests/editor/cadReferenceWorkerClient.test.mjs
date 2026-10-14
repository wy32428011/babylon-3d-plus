import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

async function loadClient() {
  let source = fs.readFileSync(new URL('../../src/editor/cad/cadReferenceWorkerClient.ts', import.meta.url), 'utf8');
  source = source.replace(/import[\s\S]*?from '[^']+';\s*/gu, '');
  source = 'const CAD_REFERENCE_MAX_GEOMETRY_BYTES=2*1024**3; const CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES=64*1024**2; function parseCadReferenceDxf(){return {small:true}};\n' + source;
  source = source.replaceAll('import.meta.url', JSON.stringify(new URL('../../src/editor/cad/cadReferenceWorkerClient.ts', import.meta.url).href));
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText + '\n//' + crypto.randomUUID()).toString('base64'));
}

class FakeWorker {
  static created = [];
  constructor() { FakeWorker.created.push(this); this.terminated = 0; }
  postMessage(request) { this.request = request; }
  terminate() { this.terminated += 1; }
  deliver(type, payload = {}) { this.onmessage?.({ data: { id: this.request.id, type, ...payload } }); }
}

test('CAD Worker 使用大小、旧导入标记和未知长度分流，大文件无 Worker 明确拒绝', async () => {
  const previous = globalThis.Worker;
  try {
    globalThis.Worker = FakeWorker;
    const client = await loadClient();
    assert.equal(client.shouldParseCadReferenceDxfInWorker(1024), false);
    assert.equal(client.shouldParseCadReferenceDxfInWorker(64*1024**2), true);
    assert.equal(client.shouldParseCadReferenceDxfInWorker(1024,{importMode:'large-preview'}), true);
    assert.equal(client.shouldParseCadReferenceDxfInWorker(undefined), true);
    assert.equal(client.shouldParseCadReferenceDxfInWorker(1024,{contentLengthBytes:64*1024**2}), true);
    globalThis.Worker = undefined;
    let reads = 0;
    await assert.rejects(client.parseCadReferenceDxfForImport({sourceUrl:'test',fileSizeBytes:64*1024**2,onProgress:()=>{},readSmallFileText:async()=>{reads++;return ''}}), /不支持 CAD 后台解析/u);
    assert.equal(reads, 0);
  } finally { globalThis.Worker = previous; }
});

test('CAD Worker 完成、取消、线程错误及消息错误释放线程和 signal listener', async () => {
  const previous = globalThis.Worker;
  try {
    globalThis.Worker = FakeWorker;
    const client = await loadClient();
    for (const mode of ['done','cancel','abort','error','messageerror','remote-error']) {
      const controller = new AbortController();
      let added=0,removed=0;
      const add=controller.signal.addEventListener.bind(controller.signal);
      const remove=controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener=(...args)=>{added++;return add(...args)};
      controller.signal.removeEventListener=(...args)=>{removed++;return remove(...args)};
      const task=client.createCadReferenceDxfWorkerTask('test',()=>{},1,{signal:controller.signal,maxGeometryBytes:1000});
      const worker=FakeWorker.created.at(-1);
      assert.equal(worker.request.maxGeometryBytes,1000);
      if(mode==='done'){
        const result={complete:true};
        worker.deliver('done',{result});
        assert.equal(await task.promise,result);
      }else{
        const rejection=assert.rejects(task.promise, mode==='cancel'||mode==='abort' ? {name:'AbortError'} : /失败/u);
        if(mode==='cancel')task.cancel();
        if(mode==='abort')controller.abort();
        if(mode==='error')worker.onerror({message:'失败'});
        if(mode==='messageerror')worker.onmessageerror({});
        if(mode==='remote-error')worker.deliver('error',{message:'传输失败'});
        await rejection;
      }
      task.cancel();
      assert.equal(worker.terminated,1);
      assert.equal(worker.onmessage,null);
      assert.equal(added,1);
      assert.equal(removed,1);
    }
    const preAborted=new AbortController();
    preAborted.abort();
    const count=FakeWorker.created.length;
    await assert.rejects(client.createCadReferenceDxfWorkerTask('test',()=>{},1,{signal:preAborted.signal}).promise,{name:'AbortError'});
    assert.equal(FakeWorker.created.length,count);
  } finally { globalThis.Worker = previous; }
});
