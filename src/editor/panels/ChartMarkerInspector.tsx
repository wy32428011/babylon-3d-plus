import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { Entity } from '../model/Entity';
import { ChartMarkerEventsInspector } from './ChartMarkerEventsInspector';
import type { ChartMarkerComponent } from '../model/components';
import { resolveChartMarker } from '../model/chartMarker';
import { isEntityEffectivelyLocked } from '../model/entityHierarchy';
import { useEditorStore } from '../store/editorStore';
import { DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE, decodeDataPlatformScreenDragPayload } from '../assets/dataPlatformScreenDrag';
import { IMAGE_ASSET_DRAG_MIME_TYPE } from '../assets/AssetDatabase';
import { CHART_MARKER_BACKGROUND_MAX_BYTES, CHART_MARKER_BACKGROUND_RASTER_TYPES, loadChartMarkerLibraryBackground } from '../assets/chartMarkerBackground';
import { CHART_MARKER_REFRESH_EVENT } from '../../shared/chartMarkerEmbed';
import '../../styles/chart-marker.css';

const MAX_BACKGROUND_BYTES = CHART_MARKER_BACKGROUND_MAX_BYTES;
const MAX_BACKGROUND_EDGE = 4096;
const BACKGROUND_MIME_TYPES = CHART_MARKER_BACKGROUND_RASTER_TYPES;

type NumberFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
};

/** 保留编辑草稿，避免键入小数或替换整个数值时立即被归一化。 */
function ChartMarkerNumberField({ label, value, min, max, step = 1, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function commit(): void {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(min, Math.min(max, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  return (
    <label className="inspector-row">
      <span>{label}</span>
      <input type="number" value={draft} min={min} max={max} step={step} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(String(value));
        }
      }} />
    </label>
  );
}

export function ChartMarkerInspector({ entity, disabled }: { entity: Entity; disabled: boolean }) {
  const [dragOver, setDragOver] = useState(false);
  const [backgroundDragOver, setBackgroundDragOver] = useState(false);
  const [error, setError] = useState('');
  const [readingImage, setReadingImage] = useState(false);
  const imageRequest = useRef(0);
  const readerRef = useRef<FileReader | null>(null);
  const backgroundFetchRef = useRef<AbortController | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const bind = useEditorStore((state) => state.bindChartMarkerScreen);
  const update = useEditorStore((state) => state.updateChartMarker);
  const entities = useEditorStore((state) => state.scene.entities);
  const marker = resolveChartMarker(entity.components.chartMarker ?? {});
  const screen = entity.components.dataPlatformScreen;
  const modelSources = Object.values(entities).filter((item) => item.components.modelAsset);
  const hasSelectedSource = modelSources.some((item) => item.id === marker.dataSourceEntityId);

  useEffect(() => {
    setReadingImage(false);
    setBackgroundDragOver(false);
    return () => {
      imageRequest.current += 1;
      backgroundFetchRef.current?.abort();
      backgroundFetchRef.current = null;
      readerRef.current?.abort();
      readerRef.current = null;
    };
  }, [entity.id, disabled]);

  function commit(patch: Partial<ChartMarkerComponent>): void {
    if (!disabled) update(entity.id, patch);
  }

  function isImageRequestCurrent(request: number): boolean {
    const state = useEditorStore.getState();
    const current = state.scene.entities[entity.id];
    return request === imageRequest.current && !disabledRef.current
      && state.scene.selectedEntityId === entity.id && !!current?.components.chartMarker
      && !isEntityEffectivelyLocked(state.scene.entities, current);
  }

  function handleBackgroundFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled) return;
    const request = beginImageRequest();
    setReadingImage(false);
    setError('');
    readBackgroundBlob(file, request);
  }

  function readBackgroundBlob(file: Blob, request: number, fromLibrary = false): void {
    if (!BACKGROUND_MIME_TYPES.includes(file.type) && !(fromLibrary && ['image/svg+xml', 'image/gif'].includes(file.type))) {
      setError('背景图片仅支持 PNG、JPEG 或 WebP 格式。');
      return;
    }
    if (!file.size || file.size > MAX_BACKGROUND_BYTES) {
      setError('请选择非空且不超过 2 MB 的背景图片。');
      return;
    }
    const reader = new FileReader();
    readerRef.current = reader;
    setReadingImage(true);
    reader.onerror = () => {
      if (!isImageRequestCurrent(request)) return;
      readerRef.current = null;
      setReadingImage(false);
      setError('背景图片读取失败，请重新选择文件。');
    };
    reader.onload = async () => {
      try {
        if (!isImageRequestCurrent(request)) return;
        if (typeof reader.result !== 'string') throw new Error('背景图片读取结果无效。');
        let dataUrl = reader.result;
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        if (!isImageRequestCurrent(request)) return;
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > MAX_BACKGROUND_EDGE || image.naturalHeight > MAX_BACKGROUND_EDGE) {
          throw new Error('背景图片宽高必须在 1 至 4096 像素之间。');
        }
        if (!BACKGROUND_MIME_TYPES.includes(file.type)) {
          // SVG/GIF 从库拖入时固化为静态 PNG，沿用场景内嵌背景格式。
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('背景图片转换失败。');
          context.drawImage(image, 0, 0);
          dataUrl = canvas.toDataURL('image/png');
          canvas.width = canvas.height = 0;
          if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 > MAX_BACKGROUND_BYTES) throw new Error('背景图片转换后超过 2 MB，请使用较小的图片。');
        }
        update(entity.id, { backgroundImage: dataUrl });
        setError('');
      } catch (cause) {
        if (isImageRequestCurrent(request)) {
          setError(cause instanceof Error && cause.message.includes('背景图片') ? cause.message : '背景图片无法解码，请选择有效的 PNG、JPEG 或 WebP 图片。');
        }
      } finally {
        if (isImageRequestCurrent(request)) {
          readerRef.current = null;
          setReadingImage(false);
        }
      }
    };
    reader.readAsDataURL(file);
  }

  function beginImageRequest(): number {
    const request = ++imageRequest.current;
    backgroundFetchRef.current?.abort();
    backgroundFetchRef.current = null;
    readerRef.current?.abort();
    readerRef.current = null;
    return request;
  }

  async function handleBackgroundDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    setBackgroundDragOver(false);
    if (disabled) return;
    const request = beginImageRequest();
    const controller = new AbortController();
    backgroundFetchRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setError('');
    setReadingImage(true);
    try {
      const file = await loadChartMarkerLibraryBackground(event.dataTransfer.getData(IMAGE_ASSET_DRAG_MIME_TYPE), controller.signal);
      if (isImageRequestCurrent(request)) readBackgroundBlob(file, request, true);
    } catch (cause) {
      if (isImageRequestCurrent(request)) {
        setReadingImage(false);
        setError(controller.signal.aborted ? '背景图片读取超时，请重试。' : cause instanceof Error ? cause.message : '背景图片读取失败，请重试。');
      }
    } finally {
      window.clearTimeout(timeout);
      if (backgroundFetchRef.current === controller) backgroundFetchRef.current = null;
    }
  }

  function restoreBackground(): void {
    beginImageRequest();
    setReadingImage(false);
    setError('');
    commit({ backgroundImage: '' });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    if (disabled) return;
    const source = decodeDataPlatformScreenDragPayload(event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE));
    if (!source || !bind(entity.id, source)) {
      setError('请拖入图表库中具有有效页面地址的大屏。');
      return;
    }
    setError('');
  }

  return (
    <>
      <fieldset className="transform-fieldset chart-marker-fieldset" disabled={disabled}>
        <legend>图表面板</legend>
        <label className="inspector-row">
          <span>关联类型</span>
          <select value={marker.contentType} onChange={(event) => commit({ contentType: event.target.value as ChartMarkerComponent['contentType'] })}>
            <option value="builtin">内置样式</option>
            <option value="screen">数据中台大屏</option>
          </select>
        </label>
        <label className="inspector-row">
          <span>文本内容</span>
          <input type="text" maxLength={4096} value={marker.text} onChange={(event) => commit({ text: event.target.value })} />
        </label>
        <ChartMarkerNumberField label="文本大小" value={marker.fontSize} min={8} max={256} onCommit={(fontSize) => commit({ fontSize })} />
        <label className="inspector-row">
          <span>开启跑马灯</span>
          <input type="checkbox" checked={marker.marquee} onChange={(event) => commit({ marquee: event.target.checked })} />
        </label>
        <div className={`chart-marker-background${backgroundDragOver ? ' is-drag-over' : ''}`}
          aria-label="图表立标背景图片槽位"
          aria-disabled={disabled}
          aria-busy={readingImage}
          onDragOver={(event) => {
            if (disabled || !event.dataTransfer.types.includes(IMAGE_ASSET_DRAG_MIME_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            setBackgroundDragOver(true);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setBackgroundDragOver(false);
          }}
          onDrop={(event) => { void handleBackgroundDrop(event); }}
        >
          <span>背景图片</span>
          <div className="chart-marker-background-preview" style={{ color: marker.backgroundColor, backgroundColor: marker.backgroundImage ? marker.backgroundColor : undefined }}>
            {marker.backgroundImage ? <img src={marker.backgroundImage} alt="图表立标背景预览" draggable={false} /> : <div className="chart-marker-default-background" aria-label="默认全息背景预览"><i /><i /><i /></div>}
          </div>
          <div className="chart-marker-actions">
            <label className="chart-marker-file-button">
              {readingImage ? '读取中…' : '选择图片'}
              <input aria-label="选择背景图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleBackgroundFile} />
            </label>
            <button type="button" onClick={restoreBackground} disabled={!marker.backgroundImage && !readingImage}>恢复默认</button>
          </div>
          <p className="muted">可从图片库拖入，也可选择本地 PNG、JPEG、WebP。最大 2 MB，宽高不超过 4096 像素；库内 SVG、GIF 作为静态背景。</p>
        </div>
        <label className="inspector-row">
          <span>背景颜色</span>
          <input type="color" value={marker.backgroundColor} onChange={(event) => commit({ backgroundColor: event.target.value })} />
        </label>
        <label className="inspector-row">
          <span>外观样式</span>
          <select value={marker.appearance} onChange={(event) => commit({ appearance: event.target.value as ChartMarkerComponent['appearance'] })}>
            <option value="line">线形</option>
            <option value="column">柱形</option>
            <option value="none">无</option>
          </select>
        </label>
        <ChartMarkerNumberField label="指示器大小" value={marker.indicatorSize} min={0.01} max={100} step={0.1} onCommit={(indicatorSize) => commit({ indicatorSize })} />
        <label className="inspector-row">
          <span>外观颜色</span>
          <input type="color" value={marker.appearanceColor} onChange={(event) => commit({ appearanceColor: event.target.value })} />
        </label>
        <ChartMarkerNumberField label="尺寸 X（px）" value={marker.width} min={16} max={4096} onCommit={(width) => commit({ width })} />
        <ChartMarkerNumberField label="尺寸 Y（px）" value={marker.height} min={16} max={4096} onCommit={(height) => commit({ height })} />
        <ChartMarkerNumberField label="悬浮高度（m）" value={marker.floatHeight} min={0} max={10000} step={0.1} onCommit={(floatHeight) => commit({ floatHeight })} />
        <label className="inspector-row">
          <span>面向摄像机</span>
          <input type="checkbox" checked={marker.faceCamera} onChange={(event) => commit({ faceCamera: event.target.checked })} />
        </label>
        <div
          className={`chart-marker-screen-slot${dragOver ? ' is-drag-over' : ''}`}
          aria-label="图表立标大屏槽位"
          aria-disabled={disabled}
          onDragOver={(event) => {
            if (disabled || !event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <strong>{screen ? marker.screenName || '已绑定大屏' : '将图表库大屏拖到这里'}</strong>
          <span>{screen ? '拖入其他大屏可替换内容' : '拖入后自动切换为数据中台大屏'}</span>
        </div>
        {screen ? (
          <div className="chart-marker-actions">
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(CHART_MARKER_REFRESH_EVENT, { detail: entity.id }))}>刷新内容</button>
            <button type="button" onClick={() => { bind(entity.id, null); setError(''); }}>清空大屏</button>
          </div>
        ) : null}
        {marker.contentType === 'screen' ? <p className="muted">大屏按自身数据源配置刷新，文本与跑马灯用于内置样式。修改大屏设计后可点击“刷新内容”重新加载。</p> : null}
        {error ? <p className="chart-marker-error" role="alert">{error}</p> : null}
      </fieldset>
      <fieldset className="transform-fieldset chart-marker-fieldset" disabled={disabled}>
        <legend>数据驱动</legend>
        <label className="inspector-row">
          <span>驱动方式</span>
          <select value={marker.driveMode} onChange={(event) => commit({ driveMode: event.target.value as ChartMarkerComponent['driveMode'] })}>
            <option value="none">无</option>
            <option value="data">DATA DRIVEN</option>
          </select>
        </label>
        <label className="inspector-row">
          <span>数据来源</span>
          <select disabled={marker.driveMode !== 'data'} value={marker.dataSourceEntityId} onChange={(event) => commit({ dataSourceEntityId: event.target.value })}>
            <option value="">无</option>
            {marker.dataSourceEntityId && !hasSelectedSource ? <option value={marker.dataSourceEntityId}>来源已失效</option> : null}
            {modelSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
        </label>
        {marker.driveMode === 'data' ? (
          <>
            <label className="inspector-row">
              <span>数据字段</span>
              <input type="text" maxLength={256} value={marker.dataField} placeholder="例如 temperature 或 status.speed" onChange={(event) => commit({ dataField: event.target.value })} />
            </label>
            <p className="muted">运行时读取所选模型的遥测字段，显示在内置样式中；无数据时显示文本内容。</p>
          </>
        ) : null}
      </fieldset>
      <ChartMarkerEventsInspector entity={entity} disabled={disabled} />
    </>
  );
}
