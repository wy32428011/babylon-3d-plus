import type { SceneOpeningAnimationSettings } from '../../../editor/model/sceneOpeningAnimation';
import { getReferenceOpeningDuration } from '../../../editor/model/sceneOpeningReference';
import { getReferenceStageStart } from '../referenceOpeningTimeline';
import { REFERENCE_ASSET_URLS,REFERENCE_ATLAS_URL } from './referenceAssets';
import { REFERENCE_DURATION_SECONDS,REFERENCE_STAGES } from './referenceStages';
import { REFERENCE_MARKUP,referenceIcon } from './referenceMarkup';
import { createWebGLRenderer } from './referenceWebGL';
import { createSoftwareRenderer } from './referenceSoftware.js';
import { createPainter,globeState } from './referencePainter.js';
import type { ReferenceGlobeRenderer,ReferenceImageMap,ReferencePainter } from './referenceTypes';
import type { OpeningPackageStage } from '../../../shared/opening/openingPackage';
import { OpeningImageBudget } from '../openingImageBudget';
import './referenceOpening.css';

export { REFERENCE_DURATION_SECONDS,REFERENCE_STAGES } from './referenceStages';
export type ReferenceRenderContext = {
  elapsedSeconds:number;
  totalDurationSeconds:number;
  isPaused:boolean;
  opacity?:number;
  stageIndex?:number;
};
export type ReferenceOpeningOptions = {
  settings:SceneOpeningAnimationSettings;
  /** 独立开场包提供已校验的本地素材；历史场景仍沿用内置图片。 */
  assetUrls?:{images:Readonly<Record<number,string>>;atlas:string};
  stageOverrides?:readonly OpeningPackageStage[];
  onSkip?:()=>void;
  onSeek?:(actualSeconds:number)=>void;
  onPauseToggle?:()=>void;
  onRestart?:()=>void;
};
export type ReferenceOpeningState = {
  ready:boolean;disposed:boolean;referenceSeconds:number;elapsedSeconds:number;totalDurationSeconds:number;
  isPaused:boolean;stageIndex:number;renderer:'loading'|'webgl'|'software'|'image';
  quality:'high'|'low';showUI:boolean;error:string|null;
};
export type ReferenceOpeningController = {
  ready:Promise<void>;
  element:HTMLElement;
  renderAt(referenceSeconds:number,context:ReferenceRenderContext):void;
  resize():void;
  getState():ReferenceOpeningState;
  dispose():void;
};

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const smooth=(start:number,end:number,value:number)=>{const t=clamp((value-start)/(end-start),0,1);return t*t*(3-2*t);};
const formatTime=(value:number)=>`${String(Math.floor(Math.max(0,value)/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,value)%60)).padStart(2,'0')}`;
const messageOf=(error:unknown)=>error instanceof Error?error.message:String(error);

/**
 * 参考 HTML 的受控适配器。没有自己的 RAF、播放计时器或完成事件，宿主拥有唯一时钟与场景交接。
 * 业务文字通过 textContent 写入；innerHTML 仅包含模块内固定的结构、图标和章节名称。
 */
export function createReferenceOpening(container:HTMLElement,options:ReferenceOpeningOptions):ReferenceOpeningController {
  if(!(container instanceof HTMLElement))throw new TypeError('参考开场需要有效的 HTMLElement 容器。');
  const {settings}=options,reference=settings.reference;
  const wrapper=document.createElement('div');
  wrapper.className=`zd-intro zd-reference-driven${reference.showUI?'':' is-clean'}`;
  wrapper.tabIndex=0;
  wrapper.setAttribute('aria-label',`${reference.brandName}数字孪生开场动画`);
  wrapper.innerHTML=REFERENCE_MARKUP;
  container.appendChild(wrapper);
  const requireElement=<T extends HTMLElement>(selector:string):T=>{
    const element=wrapper.querySelector<T>(selector);
    if(!element)throw new Error(`参考开场缺少界面元素：${selector}`);
    return element;
  };
  const role=<T extends HTMLElement>(name:string)=>requireElement<T>(`[data-role="${name}"]`);
  const els={
    backdrop:role<HTMLCanvasElement>('backdrop'),globe:role<HTMLCanvasElement>('globe'),effects:role<HTMLCanvasElement>('effects'),
    progress:role<HTMLInputElement>('progress'),play:requireElement<HTMLButtonElement>('[data-action="play"]'),
    hero:role<HTMLDivElement>('hero'),heading:requireElement<HTMLElement>('.zd-heading'),
    stageTitle:role<HTMLElement>('stage-title'),stageEn:role<HTMLElement>('stage-en'),stageDetail:role<HTMLElement>('stage-detail'),
    counter:role<HTMLElement>('stage-counter'),location:role<HTMLElement>('location'),time:role<HTMLElement>('time'),totalTime:role<HTMLElement>('total-time'),
    enter:requireElement<HTMLButtonElement>('[data-action="enter"]'),
    readout:role<HTMLElement>('readout'),readoutLine:role<HTMLElement>('readout-line'),readoutValue:role<HTMLElement>('readout-value'),
    loader:role<HTMLElement>('loader'),loadStatus:role<HTMLElement>('load-status'),loadProgress:role<HTMLElement>('load-progress'),
    toast:role<HTMLElement>('toast'),
  };
  const stageButtons=Array.from(wrapper.querySelectorAll<HTMLButtonElement>('[data-stage]'));
  stageButtons.forEach((button,index)=>{
    const stage=options.stageOverrides?.[index];
    if(!stage)return;
    const counter=document.createElement('small');counter.textContent=String(index+1).padStart(2,'0');
    button.replaceChildren(counter,document.createTextNode(stage.label));button.title=`跳转到${stage.label}`;
  });
  const embedded=window.parent!==window;
  requireElement<HTMLButtonElement>('[data-action="fullscreen"]').classList.toggle('zd-hidden',embedded);
  for(const button of stageButtons)button.disabled=!settings.allowSkip;
  els.progress.disabled=!settings.allowSkip;
  const skipButtons=Array.from(wrapper.querySelectorAll<HTMLButtonElement>('[data-action="skip"]'));
  for(const button of [...skipButtons,els.enter])button.classList.toggle('zd-hidden',!settings.allowSkip);
  role<HTMLElement>('brand-name').textContent=reference.brandName;
  role<HTMLElement>('hero-subtitle').textContent=reference.heroSubtitle;
  const heroTitle=role<HTMLElement>('hero-title');
  reference.heroTitle.split('\n').forEach((line,index)=>{
    if(index)heroTitle.appendChild(document.createElement('br'));
    if(line.endsWith('智能现场')){
      heroTitle.appendChild(document.createTextNode(line.slice(0,-4)));
      const emphasis=document.createElement('em');emphasis.textContent='智能现场';heroTitle.appendChild(emphasis);
    }else heroTitle.appendChild(document.createTextNode(line));
  });
  const state:ReferenceOpeningState={ready:false,disposed:false,referenceSeconds:0,elapsedSeconds:0,
    totalDurationSeconds:getReferenceOpeningDuration(reference),isPaused:false,stageIndex:0,
    renderer:'loading',quality:reference.quality,showUI:reference.showUI,error:null};
  let context:ReferenceRenderContext={elapsedSeconds:0,totalDurationSeconds:state.totalDurationSeconds,isPaused:false,opacity:1};
  let renderer:ReferenceGlobeRenderer|null=null,painter:ReferencePainter|null=null;
  let images:ReferenceImageMap|null=null,atlas:HTMLImageElement|null=null;
  let resizeObserver:ResizeObserver|null=null,lastSize='',lastStage=-1,lastPause:boolean|null=null;
  let loaded=0;
  const imageBudget=new OpeningImageBudget();
  const removers:Array<()=>void>=[],cancelLoads=new Set<()=>void>();
  const listen=(target:EventTarget,type:string,callback:EventListener)=>{
    target.addEventListener(type,callback);removers.push(()=>target.removeEventListener(type,callback));
  };

  function renderCurrent():void {
    if(!state.ready||state.disposed||!painter)return;
    const t=state.referenceSeconds;
    const index=Number.isInteger(context.stageIndex)?clamp(context.stageIndex!,0,8)
      :REFERENCE_STAGES.reduce((current,stage,i)=>t>=stage.start?i:current,0);
    state.stageIndex=index;
    if(index!==lastStage){
      lastStage=index;const stage=REFERENCE_STAGES[index];
      wrapper.classList.toggle('is-finale',index===8);
      const override=options.stageOverrides?.[index];
      els.stageTitle.textContent=override?.title??(index===8?reference.finaleTitle:stage.title);
      els.stageEn.textContent=override?.subtitle??stage.en;
      els.stageDetail.textContent=override?.description??(index===8?`惠山区 · ${reference.companyName}`:stage.detail);
      els.counter.textContent=`${String(index+1).padStart(2,'0')} / 09`;
      els.location.textContent=stage.place;
      stageButtons.forEach((button,i)=>{
        button.classList.toggle('active',i===index);button.classList.toggle('past',i<index);
        button.setAttribute('aria-current',i===index?'step':'false');
      });
      if(index===2){els.readoutLine.innerHTML='OUTBOUND NETWORK<br>CHINA → WORLD';els.readoutValue.textContent=`${reference.worldDestinations.length} 条演示路线 · 动态飞行`;}
      else if(index===5){els.readoutLine.innerHTML='NATIONWIDE NETWORK<br>JIANGSU → CHINA';els.readoutValue.textContent=`${reference.chinaDestinations.length} 条演示路线 · 城市连接`;}
      else if(index===8){els.readoutLine.innerHTML='DESTINATION REACHED<br>HUISHAN · WUXI';els.readoutValue.textContent='智能仓储 · 数字孪生';}
      else{els.readoutLine.innerHTML='SPATIAL SEQUENCE<br>GLOBAL → LOCAL';els.readoutValue.textContent=stage.place;}
    }
    if(renderer&&t<16.2){
      els.globe.style.display='block';els.globe.style.opacity=String(smooth(0,1.1,t));renderer.draw(globeState(t));
    }else els.globe.style.display='none';
    painter.draw(t,!!renderer,state.elapsedSeconds);
    els.hero.style.opacity=String(1-smooth(6.7,9,t));
    els.heading.style.opacity=String(t<7?.65+.35*smooth(5,7,t):1);
    els.readout.style.opacity=String(smooth(9,12,t));
    els.progress.max=String(state.totalDurationSeconds);els.progress.value=String(state.elapsedSeconds);
    const progress=state.totalDurationSeconds>0?state.elapsedSeconds/state.totalDurationSeconds:t>=62?1:0;
    els.progress.style.setProperty('--progress',`${clamp(progress,0,1)*100}%`);
    els.time.textContent=formatTime(state.elapsedSeconds);els.totalTime.textContent=formatTime(state.totalDurationSeconds);
    els.enter.classList.toggle('visible',settings.allowSkip&&t>=56.5);
    for(const button of skipButtons)button.classList.toggle('zd-hidden',!settings.allowSkip||(reference.showUI&&t>=56.5));
    if(lastPause!==state.isPaused){
      lastPause=state.isPaused;els.play.innerHTML=referenceIcon(state.isPaused?'play':'pause');
      els.play.setAttribute('aria-label',state.isPaused?'播放':'暂停');
    }
  }

  function renderAt(referenceSeconds:number,next:ReferenceRenderContext):void {
    if(state.disposed)return;
    state.referenceSeconds=Number.isFinite(referenceSeconds)?clamp(referenceSeconds,0,REFERENCE_DURATION_SECONDS):0;
    const total=Number.isFinite(next.totalDurationSeconds)&&next.totalDurationSeconds>=0?next.totalDurationSeconds:getReferenceOpeningDuration(reference);
    state.totalDurationSeconds=total;
    state.elapsedSeconds=Number.isFinite(next.elapsedSeconds)?clamp(next.elapsedSeconds,0,total):0;
    state.isPaused=next.isPaused;
    context={...next,totalDurationSeconds:total,elapsedSeconds:state.elapsedSeconds};
    const opacity=next.opacity===undefined?1:Number.isFinite(next.opacity)?clamp(next.opacity,0,1):0;
    wrapper.style.opacity=String(opacity);wrapper.style.pointerEvents=opacity>0?'':'none';
    renderCurrent();
  }

  function resize():void {
    if(state.disposed)return;
    const rect=wrapper.getBoundingClientRect(),width=Math.max(1,rect.width),height=Math.max(1,rect.height);
    const dpr=Math.min(window.devicePixelRatio||1,reference.quality==='high'?1.5:1),key=`${width}:${height}:${dpr}`;
    if(key===lastSize)return;lastSize=key;
    const scale=Math.min(width/1600,height/900);
    const sizing={width,height,scale,dpr,ox:(width-1600*scale)/2,oy:(height-900*scale)/2,viewW:width/scale/100,viewH:height/scale/100};
    painter?.resize(sizing);renderer?.resize(sizing);renderCurrent();
  }

  function replaceGlobeCanvas():void {
    const replacement=document.createElement('canvas');replacement.className=els.globe.className;
    replacement.dataset.role='globe';replacement.setAttribute('aria-hidden','true');
    els.globe.replaceWith(replacement);els.globe=replacement;
  }

  function softwareFallback(reason:unknown):void {
    if(state.disposed||!images||!atlas)return;
    console.warn('[ReferenceOpening] WebGL不可用，切换本地兼容绘制。',reason);
    renderer?.dispose();renderer=null;replaceGlobeCanvas();
    try{renderer=createSoftwareRenderer(els.globe,{images,atlas});state.renderer='software';}
    catch(error){console.warn('[ReferenceOpening] 软件球面不可用，保留图片转场绘制。',error);state.renderer='image';}
    lastSize='';resize();
  }

  function loadImage(url:string,label:string):Promise<HTMLImageElement> {
    return new Promise((resolve,reject)=>{
      const image=new Image();let settled=false;
      const cleanup=()=>{image.onload=null;image.onerror=null;cancelLoads.delete(cancel);};
      const cancel=()=>{if(settled)return;settled=true;cleanup();image.src='';reject(new Error('参考开场已释放。'));};
      cancelLoads.add(cancel);
      image.onload=()=>{
        if(settled)return;settled=true;cleanup();loaded++;
        try{imageBudget.accept(image.naturalWidth,image.naturalHeight,label);}
        catch(error){image.src='';reject(error);return;}
        if(!state.disposed){els.loadStatus.textContent=`本地资源准备中 · ${loaded} / 10`;els.loadProgress.style.width=`${loaded*10}%`;}
        resolve(image);
      };
      image.onerror=()=>{if(settled)return;settled=true;cleanup();reject(new Error(`开场资源 ${label} 加载失败。`));};
      image.src=url;
    });
  }

  async function toggleFullscreen():Promise<void> {
    if(embedded||state.disposed)return;
    // 业务 canvas 与开场覆盖层必须一起进入全屏，否则末段透明交接会露出黑底。
    const target=container.parentElement??container;
    try{
      if(document.fullscreenElement===target)await document.exitFullscreen();
      else await target.requestFullscreen();
    }catch(error){
      els.toast.textContent='当前无法切换全屏。';els.toast.classList.add('visible');
      console.warn('[ReferenceOpening] 全屏请求失败。',error);
    }
  }

  listen(wrapper,'click',event=>{
    const target=event.target instanceof Element?event.target:null;
    const stageButton=target?.closest<HTMLElement>('[data-stage]');
    if(stageButton){if(settings.allowSkip)options.onSeek?.(getReferenceStageStart(Number(stageButton.dataset.stage),reference));return;}
    const action=target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if(action==='play')options.onPauseToggle?.();
    else if(action==='restart')options.onRestart?.();
    else if((action==='skip'||action==='enter')&&settings.allowSkip)options.onSkip?.();
    else if(action==='fullscreen')void toggleFullscreen();
  });
  listen(els.progress,'input',()=>{const value=Number(els.progress.value);if(settings.allowSkip&&Number.isFinite(value))options.onSeek?.(value);});
  listen(wrapper,'keydown',event=>{
    const keyEvent=event as KeyboardEvent;
    if(keyEvent.key==='Escape'&&settings.allowSkip){keyEvent.preventDefault();keyEvent.stopPropagation();options.onSkip?.();return;}
    if(event.target instanceof HTMLElement&&['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
    if(keyEvent.key===' '){keyEvent.preventDefault();keyEvent.stopPropagation();options.onPauseToggle?.();}
    else if(keyEvent.key.toLowerCase()==='r'){keyEvent.preventDefault();options.onRestart?.();}
    else if(keyEvent.key.toLowerCase()==='f'&&!embedded){keyEvent.preventDefault();keyEvent.stopPropagation();void toggleFullscreen();}
    else if(settings.allowSkip&&(keyEvent.key==='ArrowRight'||keyEvent.key==='ArrowLeft')){
      keyEvent.preventDefault();options.onSeek?.(clamp(state.elapsedSeconds+(keyEvent.key==='ArrowRight'?3:-3),0,state.totalDurationSeconds));
    }
  });
  listen(window,'resize',resize);
  if(typeof ResizeObserver!=='undefined'){resizeObserver=new ResizeObserver(resize);resizeObserver.observe(wrapper);}

  const ready=(async():Promise<void>=>{
    try{
      const loadedImages:HTMLImageElement[]=[];let nextImage=0;
      await Promise.all(Array.from({length:4},async()=>{
        while(!state.disposed&&nextImage<9){const index=nextImage++;loadedImages[index]=await loadImage(options.assetUrls?.images[index+1]??REFERENCE_ASSET_URLS[index+1],`asset-${index+1}.webp`);}
      }));
      if(state.disposed)return;
      const loadedAtlas=await loadImage(options.assetUrls?.atlas??REFERENCE_ATLAS_URL,'asset-10.webp');
      if(state.disposed)return;
      images=Object.fromEntries(loadedImages.map((image,index)=>[index+1,image]));atlas=loadedAtlas;
      const reduced=settings.motionPreference==='reduced'||(settings.motionPreference==='system'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      painter=createPainter(els.backdrop,els.effects,images,{
        worldOrigin:[reference.worldOrigin.x,reference.worldOrigin.y],chinaOrigin:[reference.chinaOrigin.x,reference.chinaOrigin.y],
        worldDestinations:reference.worldDestinations.map(point=>[point.name,point.x,point.y] as const),
        chinaDestinations:reference.chinaDestinations.map(point=>[point.name,point.x,point.y] as const),
        worldRoutesEnabled:reference.stageDurations[2]>0,chinaRoutesEnabled:reference.stageDurations[5]>0,
        worldRouteOverrides:options.stageOverrides?.[2].routes?.map(route=>({...options.stageOverrides?.[2].routeStyle,...route})),
        chinaRouteOverrides:options.stageOverrides?.[5].routes?.map(route=>({...options.stageOverrides?.[5].routeStyle,...route})),
        breathing:{enabled:settings.breathingEnabled&&!reduced,intensity:settings.breathingIntensity,periodSeconds:settings.breathingPeriodSeconds},
      });
      try{
        renderer=createWebGLRenderer(els.globe,{images,atlas,onLost:()=>softwareFallback(new Error('WebGL context lost'))});
        state.renderer='webgl';
      }catch(error){softwareFallback(error);}
      if(state.disposed){renderer?.dispose();painter.dispose();return;}
      state.ready=true;lastSize='';resize();renderCurrent();
      // ready 表示素材和首帧已可用；加载层不再自行延迟六百毫秒遮挡外部确定性寻帧。
      els.loader.style.transition='none';els.loader.classList.add('hidden');
    }catch(error){
      if(state.disposed)return;
      for(const cancel of [...cancelLoads])cancel();
      cancelLoads.clear();renderer?.dispose();painter?.dispose();renderer=null;painter=null;
      state.error=messageOf(error);els.loadStatus.textContent=state.error;els.loadStatus.style.color='#ffb98b';
      requireElement<HTMLElement>('.zd-loader-title').textContent='资源加载失败';
      throw error;
    }
  })();

  const dispose=():void=>{
    if(state.disposed)return;state.disposed=true;
    for(const cancel of [...cancelLoads])cancel();
    cancelLoads.clear();resizeObserver?.disconnect();resizeObserver=null;
    removers.forEach(remove=>remove());removers.length=0;
    renderer?.dispose();painter?.dispose();renderer=null;painter=null;images=null;atlas=null;
    wrapper.remove();
  };
  return {ready,element:wrapper,renderAt,resize,getState:()=>({...state}),dispose};
}
