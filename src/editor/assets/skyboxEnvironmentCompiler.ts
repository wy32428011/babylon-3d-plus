import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { HDRFiltering } from '@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js';
import { CreateEnvTextureAsync } from '@babylonjs/core/Misc/environmentTextureTools.js';
import { ExrLoaderGlobalConfiguration } from '@babylonjs/core/Materials/Textures/Loaders/EXR/exrLoader.configuration.js';
import fflateUrl from '../../../node_modules/fflate/umd/index.js?url';
import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap.js';
import babylonPackage from '@babylonjs/core/package.json' with { type: 'json' };
import { inspectSkyboxEnvironmentBytes, SKYBOX_ENVIRONMENT_RECIPE,
  type SkyboxPreparationStage, type SkyboxPreparationTicket } from '../../../electron/shared/sceneSkyboxContract.ts';
import { prepareSkyboxData } from '../../runtime/babylon/skyboxDecodedData.ts';
import { PreparedSkyboxTexture } from '../../runtime/babylon/PreparedSkyboxTexture.ts';
import { BilinearEXRCubeTexture, BilinearHDRCubeTexture } from '../../runtime/babylon/BilinearSkyboxTexture.ts';
import { loadSkyboxTexture, readSkyboxTextureBlob } from '../../runtime/babylon/skyboxTextureLoad.ts';
import { waitForSkyboxPrefilter } from '../../runtime/babylon/skyboxPrefilter.ts';
import { hashSkyboxContent } from '../../runtime/babylon/skyboxContentHash.ts';
import '../../runtime/babylon/babylonSideEffects.ts';

export type SkyboxCompilerProgress = (stage: SkyboxPreparationStage, detail?: string) => void;

/** 仅供画质验证：在两份纹理仍存活于同一 Engine/Scene 时调用，用于比较内存预过滤结果与重载 ENV；产品路径不传入。 */
export type SkyboxCompilerDiagnostics = {
  onTextures?: (textures: { prefiltered: BaseTexture; reloaded: CubeTexture; engine: Engine; scene: Scene }) => Promise<void>;
};

/** 仅供编辑器使用；离屏 Engine 与业务场景无关，输出通过原生 ENV 重载后才交主进程提交。 */
export async function compileSkyboxEnvironment(ticket: SkyboxPreparationTicket, format: 'hdr' | 'exr', signal: AbortSignal,
  progress: SkyboxCompilerProgress = () => undefined, diagnostics?: SkyboxCompilerDiagnostics): Promise<Uint8Array> {
  signal.throwIfAborted();
  // Babylon 的 ZIP/ZIPS/PXR24 备用路径仍需同步解压库，固定为随应用分发的本地资源。
  ExrLoaderGlobalConfiguration.FFLATEUrl = fflateUrl;
  if (ticket.recipeKey !== SKYBOX_ENVIRONMENT_RECIPE || !ticket.recipeKey.startsWith(`babylon-${babylonPackage.version}-`)) {
    throw new Error('天空转换器版本与生成配方不一致，请更新资源准备器。');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: false, stencil: false });
  // Babylon 9.12 的 ENV RGBD 展开借用 engine.scenes[0]；没有宿主 Scene 时会留下未结算 Promise。
  const hostingScene = new Scene(engine);
  const io = new AbortController();
  let gpuWorkStarted = false;
  const abort = () => { if (!gpuWorkStarted) io.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  let texture: PreparedSkyboxTexture | BilinearEXRCubeTexture | BilinearHDRCubeTexture | undefined;
  let reloaded: CubeTexture | undefined;
  try {
    const caps = engine.getCaps();
    if (engine.webGLVersion < 2 || (!caps.textureFloatRender && !caps.textureHalfFloatRender)) {
      throw new Error('当前 GPU 不支持天空 ENV 所需的 WebGL2 浮点渲染，未生成降质产物。');
    }
    progress('source-read');
    const sourceUrl = new URL(ticket.sourceUrl, document.baseURI);
    sourceUrl.searchParams.set('assetRevision', ticket.sourceSha256);
    const blob = await readSkyboxTextureBlob(sourceUrl.href, io.signal);
    const sourceHash = await hashSkyboxContent(new Uint8Array(await blob.arrayBuffer()));
    signal.throwIfAborted();
    if (sourceHash !== ticket.sourceSha256) throw new Error('实际读取的天空源文件与准备任务 SHA-256 不一致。');
    let prepared: CubeMapInfo | null = null;
    texture = await loadSkyboxTexture(ticket.sourceUrl, io.signal, {
      read: async () => blob,
      transformBlob: async (source, loadSignal) => {
        progress('decode');
        prepared = await prepareSkyboxData(source, format, ticket.faceSize, loadSignal, {
          onStage: stage => { if (stage === 'convert') progress('convert'); },
        });
        return prepared ? new Blob([new Uint8Array(1)]) : source;
      },
      create: (url, onLoad, onError) => prepared
        ? new PreparedSkyboxTexture(url, engine, ticket.faceSize, prepared, format, onLoad, onError)
        : format === 'exr'
          ? new BilinearEXRCubeTexture(url, engine, ticket.faceSize, false, true, false, false, onLoad, onError)
          : new BilinearHDRCubeTexture(url, engine, ticket.faceSize, false, true, false, false, onLoad, onError),
      prepare: async candidate => {
        signal.throwIfAborted();
        gpuWorkStarted = true;
        progress('prefilter');
        await waitForSkyboxPrefilter(engine, () => new HDRFiltering(engine, { quality: 4096 }).prefilter(candidate));
        signal.throwIfAborted();
      },
    });
    signal.throwIfAborted();
    progress('encode');
    const bytes = new Uint8Array(await CreateEnvTextureAsync(texture, { imageType: 'image/png' }));
    signal.throwIfAborted();
    progress('validate');
    inspectSkyboxEnvironmentBytes(bytes, ticket.faceSize);
    reloaded = await loadSkyboxTexture('prepared-environment.env', new AbortController().signal, {
      read: async () => new Blob([bytes as Uint8Array<ArrayBuffer>]),
      create: (url, onLoad, onError) => new CubeTexture(url, engine, {
        prefiltered: true, forcedExtension: '.env', createPolynomials: true, onLoad, onError,
      }),
    });
    signal.throwIfAborted();
    if (!reloaded.isReady() || reloaded.getSize().width !== ticket.faceSize || !reloaded.sphericalPolynomial) {
      throw new Error('生成的天空 ENV 未通过原生加载与照明数据验证。');
    }
    await diagnostics?.onTextures?.({ prefiltered: texture, reloaded, engine, scene: hostingScene });
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    // GPU 任务已结算后才释放 Engine；取消只阻止提交，不能打断仍在读写输入的过滤过程。
    reloaded?.dispose(); texture?.dispose(); hostingScene.dispose(); engine.dispose(); canvas.remove();
  }
}
