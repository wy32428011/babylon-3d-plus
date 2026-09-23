import { getSceneShadowBakeSignatureContract } from '../shared/sceneShadowBakeContract.js';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CompositionLibraryEntry, CompositionInstance } from '../shared/compositionTypes.js';
import { compositionHash, compositionRoot, materializeComposition, readCompositionIndex } from './compositionPackage.js';
import { extractCompositionArchive, readCompositionResponse } from './compositionRemote.js';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';
import { decodeAssetUrl, encodeAssetUrl } from './assetRegistry.js';

type Json = Record<string, unknown>;
type Reference = Pick<CompositionInstance, 'libraryId'|'revision'|'resourceId'|'sourceKey'> & {packagePath:string;contentSha256:string};
type Remote = {id:string;name:string;revision:string;manifestSha256:string;packageSha256:string;memberCount:number;updatedAt:string};
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const inside = (root: string, value: string) => { const relative=path.relative(path.resolve(root),path.resolve(value));return !relative.startsWith('..')&&!path.isAbsolute(relative); };
const paths = new Set(['sourcePath','sourceUrl','packagePath','metadataPath','path','scriptPaths','thumbnailPath','thumbnailUrl']);

const responseData = readCompositionResponse;

function inferredReference(asset: Json, snapshot: Json): Json | null {
  if(object(snapshot.compositionResource))return snapshot.compositionResource;
  if(snapshot.composition!==true||typeof asset.sourcePath!=='string')return null;
  const file=asset.sourcePath.replaceAll('\\','/'),match=/(Assets\/Compositions\/([^/]+)\/([^/]+))\//i.exec(file);
  if(!match)return null;
  return {schemaVersion:1,resourceType:'ENV_MODEL',libraryId:match[2],revision:match[3],packagePath:file.slice(0,match.index+match[1].length)};
}
async function resolveVersion(source: Reference, sharedRoot: string, projectRoot: string|null, baseUrl:string, signal:AbortSignal): Promise<Reference> {
  const ref={...source};
  if(!ref.packagePath||!/^[a-f0-9]{64}$/.test(ref.contentSha256)||!/^[A-Za-z0-9-]{1,100}$/.test(ref.revision))throw new Error('组合固定版本信息无效。');
  const base=baseUrl?normalizeDataPlatformSourceUrl(baseUrl):'',sourceKey=base?createHash('sha256').update(base).digest('hex'):undefined;
  let remote:Remote|undefined;
  if (!ref.resourceId) {
    const known = (await readCompositionIndex(sharedRoot)).find(e => e.id === ref.libraryId && e.resourceId && (!sourceKey || e.sourceKey === sourceKey));
    if (known) { ref.resourceId = known.resourceId; ref.sourceKey = known.sourceKey; }
  }
  if(!ref.resourceId&&base){
    const matches=await responseData<Remote[]>(await fetch(base+'/api/v1/env-models/compositions/resolve',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:ref.revision,manifestSha256:ref.contentSha256}),signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])}));
    if(!Array.isArray(matches)||matches.length!==1)throw new Error(matches.length?'组合版本匹配到多个资源，请明确选择对应组合卡片。':'组合版本尚未同步到中台，请先同步组合库。');
    remote=matches[0];ref.resourceId=remote.id;ref.sourceKey=sourceKey;
  }
  if(ref.resourceId!==undefined&&(typeof ref.resourceId!=='string'||!/^[1-9]\d{0,19}$/.test(ref.resourceId)))throw new Error('组合资源 ID 必须为正整数字符串。');
  if(base&&ref.resourceId&&ref.sourceKey&&ref.sourceKey!==sourceKey){
    remote=await responseData<Remote>(await fetch(base+'/api/v1/env-models/compositions/'+ref.resourceId+'/versions/'+ref.revision,{signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])}));
    if(remote.manifestSha256!==ref.contentSha256)throw new Error('当前中台组合版本与场景内容不一致。');ref.sourceKey=sourceKey;
  }
  if(ref.resourceId&&sourceKey){
    const catalog=await readCompositionIndex(sharedRoot);
    ref.libraryId=catalog.find(e=>e.resourceId===ref.resourceId&&e.sourceKey===sourceKey)?.id??'remote-'+sourceKey.slice(0,16)+'-'+ref.resourceId;
  }
  const oldPath=path.resolve(ref.packagePath);
  if(inside(sharedRoot,oldPath)||(projectRoot&&inside(projectRoot,oldPath))){
    try{await materializeComposition({id:ref.libraryId,revision:ref.revision,name:'场景组合',packagePath:oldPath,contentSha256:ref.contentSha256} as CompositionLibraryEntry);return ref;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(!base||!ref.resourceId||!/^[1-9]\d{0,19}$/.test(ref.resourceId))throw new Error('组合资源缺失且尚未同步中台。');
  const packagePath=path.join(compositionRoot(sharedRoot),ref.libraryId,ref.revision);
  const entry={id:ref.libraryId,name:'场景组合',revision:ref.revision,packagePath,contentSha256:ref.contentSha256} as CompositionLibraryEntry;
  try{await materializeComposition(entry);return {...ref,packagePath};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const endpoint=base+'/api/v1/env-models/compositions/'+ref.resourceId+'/versions/'+ref.revision;
  remote??=await responseData<Remote>(await fetch(endpoint,{signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])}));
  if(remote.manifestSha256!==ref.contentSha256||!/^[a-f0-9]{64}$/.test(remote.packageSha256))throw new Error('组合版本内容摘要不一致。');
  Object.assign(entry,{name:remote.name,memberCount:remote.memberCount,updatedAt:remote.updatedAt,resourceId:ref.resourceId,remoteRevision:ref.revision,sourceKey,syncStatus:'synced'});
  const staging=path.join(compositionRoot(sharedRoot),'.recover-'+randomUUID()),temporary=staging+'.zip';
  try{
    await fs.mkdir(staging,{recursive:true});
    const downloaded=await fetch(endpoint+'/package',{signal:AbortSignal.any([signal,AbortSignal.timeout(30*60_000)])});
    if(!downloaded.ok||!downloaded.body)throw new Error('下载固定组合版本失败。');
    let bytes=0;
    await pipeline(Readable.fromWeb(downloaded.body as never),new Transform({transform(chunk:Buffer,_enc,cb){bytes+=chunk.length;cb(bytes>8*1024**3?new Error('组合包超过大小限制。'):null,chunk);}}),createWriteStream(temporary));
    if(await compositionHash(temporary)!==remote.packageSha256)throw new Error('组合包摘要校验失败。');
    await extractCompositionArchive(temporary,staging);await materializeComposition({...entry,packagePath:staging});
    await fs.mkdir(path.dirname(packagePath),{recursive:true});
    try{await fs.rename(staging,packagePath);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    await materializeComposition(entry);await fs.writeFile(path.join(packagePath,'entry.json'),JSON.stringify(entry),'utf8');
  }finally{await fs.rm(temporary,{force:true});await fs.rm(staging,{recursive:true,force:true});}
  return {...ref,packagePath,sourceKey};
}

/** 固定版本恢复同时覆盖组合根和解除组合后的成员，实例变换与业务参数保持不变。 */
export async function recoverSceneCompositions(scene:unknown,sharedRoot:string,projectRoot:string|null,baseUrl:string,signal:AbortSignal){
  const issues:Array<{resourceKind:'other';resourceId?:string;message:string}>=[];
  if(!object(scene)||!object(scene.entities))return {scene,issues};
  const oldSettings=object(scene.sceneSettings)?scene.sceneSettings:{},oldShadows=object(oldSettings.shadows)?oldSettings.shadows:{};
  const preserveBake=object(oldShadows.bake)&&oldShadows.bake.signature===getSceneShadowBakeSignatureContract(scene);
  const result=structuredClone(scene),entities=result.entities as Record<string,Json>,resolved=new Map<string,Promise<Reference>>();
  for(const original of Object.values(entities)){
    const root=entities[String(original.id)];
    const components=object(root.components)?root.components:{},asset=object(components.modelAsset)?components.modelAsset:{},snapshot=object(asset.sourceSnapshot)?asset.sourceSnapshot:{};
    const grouped=object(root.composition),raw=grouped?root.composition:inferredReference(asset,snapshot);
    if(!object(raw))continue;
    if(!grouped){let parent=root.parentId,groupedParent=false;const seen=new Set();while(typeof parent==='string'&&entities[parent]&&!seen.has(parent)){seen.add(parent);if(entities[parent].composition){groupedParent=true;break;}parent=entities[parent].parentId;}if(groupedParent)continue;}
    const source={...raw,contentSha256:grouped?raw.contentSha256:snapshot.contentSha256} as unknown as Reference;
    try{
      signal.throwIfAborted();
      const key=JSON.stringify([source.packagePath,source.resourceId,source.revision,source.contentSha256,source.sourceKey]);
      if(!resolved.has(key))resolved.set(key,resolveVersion(source,sharedRoot,projectRoot,baseUrl,signal));
      const target=await resolved.get(key)!;signal.throwIfAborted();
      const rewrite=(value:unknown,field=''):unknown=>{
        if(typeof value==='string'&&(paths.has(field)||value.startsWith('editor-asset://'))){
          const url=value.startsWith('editor-asset://'),file=url?decodeAssetUrl(value):value;
          if(path.isAbsolute(file)&&inside(source.packagePath,file)){const relocated=path.join(target.packagePath,path.relative(source.packagePath,file));return url?encodeAssetUrl(relocated):relocated;}return value;
        }
        if(Array.isArray(value))return value.map(v=>rewrite(v,field));
        if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v,k)]));return value;
      };
      const pending=[String(root.id)],seen=new Set<string>();
      while(pending.length){
        const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);if(seen.size>100000)throw new Error('组合成员数量超过恢复限制。');
        const entity=entities[id];if(!entity)throw new Error('组合成员缺失。');entities[id]=rewrite(entity) as Json;
        const parts=object(entities[id].components)?entities[id].components as Json:{},model=object(parts.modelAsset)?parts.modelAsset:{},saved=object(model.sourceSnapshot)?model.sourceSnapshot:{};
        const reference=object(saved.compositionResource)?saved.compositionResource:{};
        if(saved.composition===true&&saved.contentSha256===source.contentSha256&&typeof model.sourcePath==='string'&&inside(target.packagePath,model.sourcePath)
          &&(!reference.resourceId||reference.resourceId===source.resourceId||reference.resourceId===target.resourceId)) {
          saved.compositionResource={schemaVersion:1,resourceType:'ENV_MODEL',libraryId:target.libraryId,resourceId:target.resourceId,revision:target.revision,sourceKey:target.sourceKey,packagePath:target.packagePath};
        }
        if(Array.isArray(entity.childrenIds))pending.push(...entity.childrenIds.map(String));
      }
      if(grouped)entities[String(root.id)].composition={...root.composition as Json,...target,resourceType:'ENV_MODEL'};
      else{
        const current=entities[String(root.id)],parts=current.components as Json,model=parts.modelAsset as Json,currentSnapshot=model.sourceSnapshot as Json;
        currentSnapshot.compositionResource={schemaVersion:1,resourceType:'ENV_MODEL',libraryId:target.libraryId,resourceId:target.resourceId,revision:target.revision,sourceKey:target.sourceKey,packagePath:target.packagePath};
      }
    }catch(error){signal.throwIfAborted();issues.push({resourceKind:'other',resourceId:source.resourceId,message:'组合“'+String(root.name)+'”：'+(error instanceof Error?error.message:String(error))});}
  }
  const settings=object(result.sceneSettings)?result.sceneSettings:{},shadows=object(settings.shadows)?settings.shadows:{};
  if(preserveBake&&object(shadows.bake))shadows.bake.signature=getSceneShadowBakeSignatureContract(result);
  return {scene:result,issues};
}
