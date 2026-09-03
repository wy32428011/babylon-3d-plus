import { DynamicTexture, Material, Mesh, Scene, ShaderMaterial, Texture } from '@babylonjs/core';
import type { ChartMarkerTextureFrame } from './chartMarkerContent';

export type ScreenPolygon = readonly { x: number; y: number }[];
type PixelRect = { x: number; y: number; width: number; height: number };

/** 合并相邻扫描行的透明区间，避免为每个像素生成一段 CSS 路径。 */
function transparentRects(data: Uint8ClampedArray, width: number, height: number): PixelRect[] {
  const result: PixelRect[] = [];
  let previous = new Map<string, PixelRect>();
  for (let y = 0; y < height; y++) {
    const current = new Map<string, PixelRect>();
    let x = 0;
    while (x < width) {
      if (data[(y * width + x) * 4 + 3] !== 0) { x++; continue; }
      const start = x++;
      while (x < width && data[(y * width + x) * 4 + 3] === 0) x++;
      const key = `${start}:${x}`;
      const rect = previous.get(key) ?? { x: start, y, width: x - start, height: 0 };
      if (!previous.has(key)) result.push(rect);
      rect.height++;
      current.set(key, rect);
    }
    previous = current;
  }
  return result;
}

/**
 * 与场景共用深度缓冲，在立标可见片元写入透明孔，使下层实时网页接受模型遮挡。
 * 原材质只在一帧内替换，文档同步、缩略图和选择工具仍持有原材质。
 */
export class ChartMarkerDepthSurface {
  readonly root: HTMLDivElement;
  private readonly material: ShaderMaterial;
  private readonly originals = new Map<Mesh, Material | null>();
  private readonly transparentMaterials = new Map<Mesh, { material: ShaderMaterial; texture: DynamicTexture; revision: number; width: number; height: number; canvas: HTMLCanvasElement }>();
  private readonly bitmap = document.createElement('canvas');
  private readonly context = this.bitmap.getContext('2d', { willReadFrequently: true })!;
  private readonly originalStyle: Pick<CSSStyleDeclaration, 'position' | 'zIndex' | 'background' | 'clipPath'>;

  constructor(private readonly scene: Scene, private readonly canvas: HTMLCanvasElement) {
    this.originalStyle = {
      position: canvas.style.position, zIndex: canvas.style.zIndex,
      background: canvas.style.background, clipPath: canvas.style.clipPath,
    };
    Object.assign(canvas.style, { position: 'relative', zIndex: '1', background: 'transparent' });
    this.root = document.createElement('div');
    this.root.dataset.chartMarkerDepthLayer = '';
    this.root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0';
    canvas.parentElement!.append(this.root);
    this.material = new ShaderMaterial('chart-marker-depth-surface', scene, {
      vertexSource: 'precision highp float; attribute vec3 position; uniform mat4 worldViewProjection; void main(){gl_Position=worldViewProjection*vec4(position,1.0);}',
      fragmentSource: 'precision highp float; void main(){gl_FragColor=vec4(0.0);}',
    }, { attributes: ['position'], uniforms: ['worldViewProjection'], needAlphaBlending: false });
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = false;
    this.material.transparencyMode = Material.MATERIAL_OPAQUE;
  }

  beginFrame(meshes: readonly Mesh[], transparentContents: ReadonlyMap<Mesh, ChartMarkerTextureFrame> = new Map()): void {
    this.endFrame();
    for (const [mesh, entry] of this.transparentMaterials) {
      if (transparentContents.has(mesh) && !mesh.isDisposed()) continue;
      entry.material.dispose();
      entry.texture.dispose();
      this.transparentMaterials.delete(mesh);
    }
    for (const mesh of meshes) {
      if (mesh.isDisposed()) continue;
      this.originals.set(mesh, mesh.material);
      const content = transparentContents.get(mesh);
      mesh.material = content ? this.getTransparentMaterial(mesh, content) : this.material;
    }
  }

  private getTransparentMaterial(mesh: Mesh, content: ChartMarkerTextureFrame): ShaderMaterial {
    const { width, height } = content.canvas;
    let entry = this.transparentMaterials.get(mesh);
    if (entry && (entry.width !== width || entry.height !== height || entry.canvas !== content.canvas)) {
      entry.material.dispose();
      entry.texture.dispose();
      this.transparentMaterials.delete(mesh);
      entry = undefined;
    }
    if (!entry) {
      const texture = new DynamicTexture('chart-marker-transparent-content', content.canvas, this.scene, false, Texture.BILINEAR_SAMPLINGMODE);
      texture.hasAlpha = true;
      texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      const material = new ShaderMaterial('chart-marker-transparent-content', this.scene, {
        vertexSource: 'precision highp float; attribute vec3 position; attribute vec2 uv; uniform mat4 worldViewProjection; varying vec2 vUV; void main(){vUV=uv;gl_Position=worldViewProjection*vec4(position,1.0);}',
        fragmentSource: 'precision highp float; varying vec2 vUV; uniform sampler2D content; void main(){vec2 p=vec2(gl_FrontFacing?1.0-vUV.x:vUV.x,1.0-vUV.y);vec4 color=texture2D(content,p);if(color.a==0.0)discard;gl_FragColor=color;}',
      }, { attributes: ['position', 'uv'], uniforms: ['worldViewProjection'], samplers: ['content'], needAlphaBlending: true });
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.setTexture('content', texture);
      entry = { material, texture, revision: -1, width, height, canvas: content.canvas };
      this.transparentMaterials.set(mesh, entry);
    }
    if (entry.revision !== content.revision) {
      entry.texture.update(true);
      entry.revision = content.revision;
    }
    return entry.material;
  }

  endFrame(): void {
    for (const [mesh, material] of this.originals) {
      if (!mesh.isDisposed() && (mesh.material === this.material || mesh.material === this.transparentMaterials.get(mesh)?.material)) mesh.material = material;
    }
    this.originals.clear();
  }

  /**
   * CSS 透明像素仍会截获点击。仅在运行交互态读取立标覆盖区域的 alpha，
   * 裁掉 canvas 中完全透明的孔，让浏览器将点击直接交给后方跨域 iframe。
   * 柱子、玻璃和光晕的非零 alpha 像素继续留在 canvas，不需要重绘或遍历模型。
   */
  updateInteraction(polygons: readonly ScreenPolygon[], interactive: boolean): void {
    if (!interactive || !polygons.length) {
      this.canvas.style.clipPath = this.originalStyle.clipPath;
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    // 仅合并重叠区域；两个相隔较远的小牌不会触发全视口像素读回。
    const regions: PixelRect[] = [];
    for (const points of polygons) {
      const x = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
      const y = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
      const right = Math.min(Math.ceil(bounds.width), Math.ceil(Math.max(...points.map(p => p.x))));
      const bottom = Math.min(Math.ceil(bounds.height), Math.ceil(Math.max(...points.map(p => p.y))));
      if (right <= x || bottom <= y) continue;
      let region = { x, y, width: right - x, height: bottom - y };
      for (let i = 0; i < regions.length;) {
        const other = regions[i];
        if (region.x >= other.x + other.width || other.x >= region.x + region.width
          || region.y >= other.y + other.height || other.y >= region.y + region.height) { i++; continue; }
        const left = Math.min(region.x, other.x), top = Math.min(region.y, other.y);
        region = { x: left, y: top, width: Math.max(region.x + region.width, other.x + other.width) - left,
          height: Math.max(region.y + region.height, other.y + other.height) - top };
        regions.splice(i, 1);
        i = 0;
      }
      regions.push(region);
    }
    const holes = regions.map(region => this.readTransparentRegion(region, polygons, bounds)).join('');
    this.canvas.style.clipPath = holes
      ? `path(evenodd, "M0 0H${bounds.width}V${bounds.height}H0Z${holes}")`
      : this.originalStyle.clipPath;
  }

  private readTransparentRegion(region: PixelRect, polygons: readonly ScreenPolygon[], bounds: DOMRect): string {
    const { x: left, y: top, width, height } = region;
    if (this.bitmap.width !== width) this.bitmap.width = width;
    if (this.bitmap.height !== height) this.bitmap.height = height;
    const ctx = this.context;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    for (const polygon of polygons) {
      polygon.forEach((p, i) => i === 0 ? ctx.moveTo(p.x - left, p.y - top) : ctx.lineTo(p.x - left, p.y - top));
      ctx.closePath();
    }
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    const scaleX = this.canvas.width / bounds.width, scaleY = this.canvas.height / bounds.height;
    ctx.drawImage(this.canvas, left * scaleX, top * scaleY, width * scaleX, height * scaleY, 0, 0, width, height);
    ctx.restore();
    const rects = transparentRects(ctx.getImageData(0, 0, width, height).data, width, height);
    return rects.map(r => {
      const x = left + r.x, y = top + r.y;
      return `M${x} ${y}h${r.width}v${r.height}h${-r.width}Z`;
    }).join('');
  }

  dispose(): void {
    this.endFrame();
    this.material.dispose();
    for (const entry of this.transparentMaterials.values()) { entry.material.dispose(); entry.texture.dispose(); }
    this.transparentMaterials.clear();
    this.root.remove();
    this.bitmap.width = this.bitmap.height = 0;
    Object.assign(this.canvas.style, this.originalStyle);
  }
}
