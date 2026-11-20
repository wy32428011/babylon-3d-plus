import { Material } from '@babylonjs/core/Materials/material.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { CadReferenceAnnotation } from '../../../editor/cad/cadReferenceAnnotations';
import { CAD_REFERENCE_GRID_Y_OFFSET_METERS } from '../../../editor/cad/cadReferenceCore';

const FONT_SIZE = 48;
const FONT = `${FONT_SIZE}px Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
const MAX_ATLAS_SIZE = 1024;
const GLYPH_PADDING = 3;
const MAX_BATCH_GLYPHS = Math.floor(65_535 / 4);
const ANNOTATION_Y = CAD_REFERENCE_GRID_Y_OFFSET_METERS + 0.01;
const MTEXT_LINE_SPACING = 5 / 3;

type GlyphTile = {
  text: string;
  countsByLayer: Map<string, number>;
  left: number;
  right: number;
  top: number;
  bottom: number;
  x: number;
  y: number;
  page: number;
};

type Glyph = { advance: number; tile: GlyphTile | null };

type GlyphPage = {
  tiles: GlyphTile[];
  width: number;
  height: number;
  countsByLayer: Map<string, number>;
};

type GlyphBatch = {
  used: number;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
};

type LayerBatches = {
  material: StandardMaterial;
  remaining: number;
  batch: GlyphBatch;
  meshes: Mesh[];
};

function prepareCanvasContext(context: CanvasRenderingContext2D): void {
  context.font = FONT;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

function measureAnnotations(
  labels: readonly CadReferenceAnnotation[],
  context: CanvasRenderingContext2D,
) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const glyphs = new Map<string, Glyph>();
  const tiles: GlyphTile[] = [];
  prepareCanvasContext(context);
  const capHeight = context.measureText('H').actualBoundingBoxAscent || FONT_SIZE;

  const annotations = labels.map((label) => {
    const layerName = label.layerName ?? '0';
    const lines = label.text.split(/\r\n?|\n/u).map((line) => {
      const run: Glyph[] = [];
      let width = 0;
      let top = capHeight;
      let bottom = 0;
      for (const { segment } of segmenter.segment(line)) {
        let glyph = glyphs.get(segment);
        if (!glyph) {
          const metrics = context.measureText(segment);
          const tile = /^\s+$/u.test(segment)
            ? null
            : {
                text: segment,
                countsByLayer: new Map<string, number>(),
                left: Math.floor(-metrics.actualBoundingBoxLeft) - GLYPH_PADDING,
                right: Math.ceil(metrics.actualBoundingBoxRight) + GLYPH_PADDING,
                top: Math.ceil(metrics.actualBoundingBoxAscent) + GLYPH_PADDING,
                bottom: Math.floor(-metrics.actualBoundingBoxDescent) - GLYPH_PADDING,
                x: 0,
                y: 0,
                page: 0,
              };
          if (tile) tiles.push(tile);
          glyph = { advance: metrics.width, tile };
          glyphs.set(segment, glyph);
        }
        if (glyph.tile) {
          const { countsByLayer } = glyph.tile;
          countsByLayer.set(layerName, (countsByLayer.get(layerName) ?? 0) + 1);
          top = Math.max(top, glyph.tile.top - GLYPH_PADDING);
          bottom = Math.min(bottom, glyph.tile.bottom + GLYPH_PADDING);
        }
        run.push(glyph);
        width += glyph.advance;
      }
      return { run, width, top, bottom };
    });
    return { label, layerName, lines };
  });
  return { annotations, tiles, capHeight };
}

/** 按行填充纹理，超出单页的字形继续放到下一页。 */
function packAtlasPages(tiles: readonly GlyphTile[], sizeLimit: number): GlyphPage[] {
  const pages: GlyphPage[] = [];
  let page: GlyphPage | undefined;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const tile of tiles) {
    const width = tile.right - tile.left;
    const height = tile.top - tile.bottom;
    if (!(width > 0 && height > 0 && width <= sizeLimit && height <= sizeLimit)) {
      throw new Error(`无法将 CAD 标注字形「${tile.text}」放入纹理图集。`);
    }
    if (x + width > sizeLimit) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (!page || y + height > sizeLimit) {
      page = { tiles: [], width: 0, height: 0, countsByLayer: new Map() };
      pages.push(page);
      x = 0;
      y = 0;
      rowHeight = 0;
    }
    tile.x = x;
    tile.y = y;
    tile.page = pages.length - 1;
    x += width;
    rowHeight = Math.max(rowHeight, height);
    page.tiles.push(tile);
    for (const [layer, count] of tile.countsByLayer) {
      page.countsByLayer.set(layer, (page.countsByLayer.get(layer) ?? 0) + count);
    }
    page.width = Math.max(page.width, x);
    page.height = Math.max(page.height, y + rowHeight);
  }
  return pages;
}

function createAtlasTexture(name: string, page: GlyphPage, scene: Scene): DynamicTexture {
  const width = 2 ** Math.ceil(Math.log2(page.width));
  const height = 2 ** Math.ceil(Math.log2(page.height));
  const canvas = scene.getEngine().createCanvas(width, height);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  if (!context) throw new Error('无法创建 CAD 标注纹理的 Canvas 2D 上下文。');
  prepareCanvasContext(context);
  context.fillStyle = '#fff';
  for (const tile of page.tiles) {
    context.fillText(tile.text, tile.x - tile.left, tile.y + tile.top);
  }
  const texture = new DynamicTexture(`${name}_atlas`, canvas, scene, true);
  try {
    texture.hasAlpha = true;
    texture.update(true);
    return texture;
  } catch (error) {
    texture.dispose();
    throw error;
  }
}

function allocateBatch(remaining: number): GlyphBatch {
  const count = Math.min(remaining, MAX_BATCH_GLYPHS);
  return {
    used: 0,
    positions: new Float32Array(count * 12),
    uvs: new Float32Array(count * 8),
    indices: new Uint16Array(count * 6),
  };
}

/** 将居中的 CAD 米坐标映射到 +X/+Z。逐个释放 Mesh 会在最后一批清理材质和共享图集。 */
export function createCadReferenceAnnotationMeshes(
  entityId: string,
  root: TransformNode,
  labels: readonly CadReferenceAnnotation[],
): Mesh[] {
  if (labels.length === 0) return [];
  const scene = root.getScene();
  const engine = scene.getEngine();
  const context = engine.createCanvas(1, 1).getContext('2d') as CanvasRenderingContext2D;
  if (!context) throw new Error('无法创建 CAD 标注测量的 Canvas 2D 上下文。');
  const { annotations, tiles, capHeight } = measureAnnotations(labels, context);
  const maxTextureSize = Math.min(MAX_ATLAS_SIZE, engine.getCaps().maxTextureSize);
  const atlasPages = packAtlasPages(tiles, 2 ** Math.floor(Math.log2(maxTextureSize)));
  const pages: Array<{
    texture: DynamicTexture;
    width: number;
    height: number;
    layers: Map<string, LayerBatches>;
  }> = [];
  const meshes: Mesh[] = [];

  try {
    for (const [index, page] of atlasPages.entries()) {
      const name = `${entityId}_cadText_${index}`;
      const texture = createAtlasTexture(name, page, scene);
      const { width, height } = texture.getSize();
      const layers = new Map<string, LayerBatches>();
      pages.push({ texture, width, height, layers });
      for (const [layerName, count] of page.countsByLayer) {
        const batch = allocateBatch(count);
        const material = new StandardMaterial(`${name}_layer_${layers.size}`, scene);
        layers.set(layerName, { material, remaining: count, batch, meshes: [] });
        material.disableLighting = true;
        material.useEmissiveAsIllumination = true;
        material.emissiveColor = Color3.White();
        material.diffuseColor = Color3.Black();
        material.specularColor = Color3.Black();
        material.backFaceCulling = false;
        material.transparencyMode = Material.MATERIAL_ALPHABLEND;
        material.opacityTexture = texture;
      }
    }

    for (const { label, layerName, lines } of annotations) {
      let scaleY = label.height / capHeight;
      let scaleX = scaleY * (label.widthFactor ?? 1);
      if (label.fit && lines[0].width > 0) {
        scaleX = (label.fit.widthInHeights * label.height) / lines[0].width;
        if (label.fit.preserveAspectRatio) scaleY = scaleX;
      }
      const lineSpacing = capHeight * MTEXT_LINE_SPACING * (label.lineSpacingFactor ?? 1);
      let top = capHeight;
      let bottom = 0;
      for (const [index, line] of lines.entries()) {
        top = Math.max(top, line.top - index * lineSpacing);
        bottom = Math.min(bottom, line.bottom - index * lineSpacing);
      }
      const verticalOffset = {
        top: -top,
        middle: -(top + bottom) / 2,
        bottom: -bottom,
        baseline: 0,
      }[label.verticalAlignment];
      const horizontalAlignment = { left: 0, center: 0.5, right: 1 }[label.horizontalAlignment];
      const cos = Math.cos(label.rotationRadians);
      const sin = Math.sin(label.rotationRadians);
      const xDirection = (label.flipX ? -1 : 1) * scaleX;
      const yDirection = (label.flipY ? -1 : 1) * scaleY;
      const rightX = cos * xDirection;
      const rightZ = sin * xDirection;
      const upX = -sin * yDirection;
      const upZ = cos * yDirection;

      for (const [index, { run, width }] of lines.entries()) {
        let pen = -width * horizontalAlignment;
        const baseline = verticalOffset - index * lineSpacing;
        for (const { advance, tile } of run) {
          const glyphLeft = pen + (tile?.left ?? 0);
          pen += advance;
          if (!tile) continue;
          const page = pages[tile.page];
          const layer = page.layers.get(layerName)!;
          const batch = layer.batch;
          const glyphBottom = baseline + tile.bottom;
          const tileWidth = tile.right - tile.left;
          const tileHeight = tile.top - tile.bottom;
          const leftX = label.x + glyphLeft * rightX + glyphBottom * upX;
          const leftZ = label.y + glyphLeft * rightZ + glyphBottom * upZ;
          const widthX = tileWidth * rightX;
          const widthZ = tileWidth * rightZ;
          const heightX = tileHeight * upX;
          const heightZ = tileHeight * upZ;
          const u0 = tile.x / page.width;
          const u1 = (tile.x + tileWidth) / page.width;
          // DynamicTexture.update(true) 将画布朝下的 Y 翻转为朝上的 V。
          const v0 = 1 - (tile.y + tileHeight) / page.height;
          const v1 = 1 - tile.y / page.height;
          const vertex = batch.used * 4;
          batch.positions.set(
            [
              leftX,
              ANNOTATION_Y,
              leftZ,
              leftX + widthX,
              ANNOTATION_Y,
              leftZ + widthZ,
              leftX + widthX + heightX,
              ANNOTATION_Y,
              leftZ + widthZ + heightZ,
              leftX + heightX,
              ANNOTATION_Y,
              leftZ + heightZ,
            ],
            batch.used * 12,
          );
          batch.uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], batch.used * 8);
          batch.indices.set(
            [vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3],
            batch.used * 6,
          );
          batch.used += 1;
          if (batch.used * 6 !== batch.indices.length) continue;

          const mesh = new Mesh(`${entityId}_cadTextMesh_${meshes.length}`, scene);
          meshes.push(mesh);
          layer.meshes.push(mesh);
          const data = new VertexData();
          data.positions = batch.positions;
          data.uvs = batch.uvs;
          data.indices = batch.indices;
          data.applyToMesh(mesh);
          mesh.parent = root;
          mesh.material = layer.material;
          mesh.isPickable = false;
          mesh.metadata = { cadReferenceLayer: layerName };
          layer.remaining -= batch.used;
          if (layer.remaining > 0) layer.batch = allocateBatch(layer.remaining);
        }
      }
    }
  } catch (error) {
    for (const mesh of meshes) mesh.dispose();
    for (const { texture, layers } of pages) {
      for (const { material } of layers.values()) material.dispose();
      texture.dispose();
    }
    throw error;
  }

  for (const { texture, layers } of pages) {
    let materialCount = layers.size;
    for (const { material, meshes: layerMeshes } of layers.values()) {
      let materialDisposed = false;
      material.onDisposeObservable.addOnce(() => {
        materialDisposed = true;
        materialCount -= 1;
        if (materialCount === 0) texture.dispose();
      });
      let meshCount = layerMeshes.length;
      for (const mesh of layerMeshes) {
        mesh.onDisposeObservable.addOnce(() => {
          meshCount -= 1;
          if (meshCount === 0 && !materialDisposed) material.dispose();
        });
      }
    }
  }
  return meshes;
}
