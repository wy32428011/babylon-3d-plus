import {
  AbstractMesh,
  Color3,
  Constants,
  Effect,
  Scene,
  SelectionOutlineLayer,
  ShaderLanguage,
  ShaderStore,
  VertexBuffer,
} from '@babylonjs/core';

export const SCENE_SELECTION_GLOW_COLOR_HEX = '#8B0000';
export const SCENE_SELECTION_GLOW_BLUR_PIXELS = 5;
const SCENE_SELECTION_GLOW_INTENSITY = 0.82;
const SCENE_SELECTION_FALLBACK_OUTLINE_THICKNESS_PIXELS = 1;
const SCENE_SELECTION_OCCLUSION_THRESHOLD = 0.000001;
const SCENE_SELECTION_HIGHLIGHT_LAYER_NAME = 'EditorModelSelectionHighlightLayer';
const SCENE_SELECTION_HIGHLIGHT_SHADER_NAME = 'sceneSelectionHighlight';

const SCENE_SELECTION_HIGHLIGHT_GLSL = `uniform sampler2D maskSampler;
uniform sampler2D depthSampler;
varying vec2 vUV;
uniform vec2 screenSize;
uniform vec3 glowColor;
uniform float glowRadius;
uniform float glowIntensity;
uniform float occlusionStrength;
uniform float occlusionThreshold;
uniform float reverseDepth;
#define CUSTOM_FRAGMENT_DEFINITIONS
vec2 readSelection(vec2 uv) {
  return texture2D(maskSampler, clamp(uv, vec2(0.0), vec2(1.0))).rg;
}
float selectionVisibility(vec2 selection, float sceneDepth) {
  float selected = step(0.0001, selection.x);
  float normalDepthVisible = step(selection.y - occlusionThreshold, sceneDepth);
  float reverseDepthVisible = step(sceneDepth - occlusionThreshold, selection.y);
  float depthVisible = mix(normalDepthVisible, reverseDepthVisible, reverseDepth);
  return selected * (1.0 - occlusionStrength * (1.0 - depthVisible));
}
float sampleGlowRing(float radius, float sceneDepth) {
  vec2 offset = vec2(radius) / screenSize;
  float glowAlpha = 0.0;
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(offset.x, 0.0)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(-offset.x, 0.0)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(0.0, offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(0.0, -offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + offset), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(-offset.x, offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV + vec2(offset.x, -offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(vUV - offset), sceneDepth));
  return glowAlpha;
}
void main(void) {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
  float sceneDepth = texture2D(depthSampler, vUV).r;
  vec2 centerSelection = readSelection(vUV);
  float outsideSelection = 1.0 - step(0.0001, centerSelection.x);
  float innerGlow = sampleGlowRing(max(1.0, glowRadius * 0.25), sceneDepth);
  float middleGlow = sampleGlowRing(max(1.0, glowRadius * 0.625), sceneDepth);
  float outerGlow = sampleGlowRing(glowRadius, sceneDepth);
  float glowAlpha = max(innerGlow * 0.58, max(middleGlow * 0.3, outerGlow * 0.12));
  gl_FragColor = vec4(glowColor, outsideSelection * glowAlpha * glowIntensity);
#define CUSTOM_FRAGMENT_MAIN_END
}`;

const SCENE_SELECTION_HIGHLIGHT_WGSL = `var maskSamplerSampler: sampler;
var maskSampler: texture_2d<f32>;
var depthSamplerSampler: sampler;
var depthSampler: texture_2d<f32>;
varying vUV: vec2f;
uniform screenSize: vec2f;
uniform glowColor: vec3f;
uniform glowRadius: f32;
uniform glowIntensity: f32;
uniform occlusionStrength: f32;
uniform occlusionThreshold: f32;
uniform reverseDepth: f32;
#define CUSTOM_FRAGMENT_DEFINITIONS
fn readSelection(uv: vec2f) -> vec2f {
  return textureSampleLevel(
    maskSampler,
    maskSamplerSampler,
    clamp(uv, vec2f(0.0), vec2f(1.0)),
    0.0
  ).rg;
}
fn selectionVisibility(selection: vec2f, sceneDepth: f32) -> f32 {
  let selected: f32 = step(0.0001, selection.x);
  let normalDepthVisible: f32 = step(selection.y - uniforms.occlusionThreshold, sceneDepth);
  let reverseDepthVisible: f32 = step(sceneDepth - uniforms.occlusionThreshold, selection.y);
  let depthVisible: f32 = mix(normalDepthVisible, reverseDepthVisible, uniforms.reverseDepth);
  return selected * (1.0 - uniforms.occlusionStrength * (1.0 - depthVisible));
}
fn sampleGlowRing(radius: f32, sceneDepth: f32, uv: vec2f) -> f32 {
  let offset: vec2f = vec2f(radius) / uniforms.screenSize;
  var glowAlpha: f32 = 0.0;
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(offset.x, 0.0)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(-offset.x, 0.0)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(0.0, offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(0.0, -offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + offset), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(-offset.x, offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv + vec2f(offset.x, -offset.y)), sceneDepth));
  glowAlpha = max(glowAlpha, selectionVisibility(readSelection(uv - offset), sceneDepth));
  return glowAlpha;
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
  let sceneDepth: f32 = textureSampleLevel(
    depthSampler,
    depthSamplerSampler,
    fragmentInputs.vUV,
    0.0
  ).r;
  let centerSelection: vec2f = readSelection(fragmentInputs.vUV);
  let outsideSelection: f32 = 1.0 - step(0.0001, centerSelection.x);
  let innerGlow: f32 = sampleGlowRing(
    max(1.0, uniforms.glowRadius * 0.25),
    sceneDepth,
    fragmentInputs.vUV
  );
  let middleGlow: f32 = sampleGlowRing(
    max(1.0, uniforms.glowRadius * 0.625),
    sceneDepth,
    fragmentInputs.vUV
  );
  let outerGlow: f32 = sampleGlowRing(uniforms.glowRadius, sceneDepth, fragmentInputs.vUV);
  let glowAlpha: f32 = max(innerGlow * 0.58, max(middleGlow * 0.3, outerGlow * 0.12));
  fragmentOutputs.color = vec4f(
    uniforms.glowColor,
    outsideSelection * glowAlpha * uniforms.glowIntensity
  );
#define CUSTOM_FRAGMENT_MAIN_END
}`;

let shadersRegistered = false;

function registerSceneSelectionHighlightShaders(): void {
  if (shadersRegistered) return;
  ShaderStore.ShadersStore[`${SCENE_SELECTION_HIGHLIGHT_SHADER_NAME}PixelShader`] = SCENE_SELECTION_HIGHLIGHT_GLSL;
  ShaderStore.ShadersStoreWGSL[`${SCENE_SELECTION_HIGHLIGHT_SHADER_NAME}PixelShader`] = SCENE_SELECTION_HIGHLIGHT_WGSL;
  shadersRegistered = true;
}

function releaseSceneSelectionDepthRendererIfUnused(scene: Scene): void {
  const hasActiveDepthOccludedSelection = scene.effectLayers.some((effectLayer) => (
    effectLayer instanceof SelectionOutlineLayer
    && effectLayer.shouldRender()
    && effectLayer.useDepthOcclusion
    && effectLayer.occlusionStrength > 0
  ));
  if (!hasActiveDepthOccludedSelection) scene.disableDepthRenderer();
}

/** Babylon 9.12 将实际合成委托给独立 ThinSelectionOutlineLayer；升级依赖时需同步复核此最小内部协议。 */
type SelectionHighlightThinLayer = {
  _createMergeEffect: () => Effect;
  _internalCompose: (effect: Effect, renderIndex: number) => void;
  _numInternalDraws: () => number;
  _disposeMergeEffects: () => void;
  bindTexturesForCompose: (effect: Effect) => void;
  textureWidth: number;
  textureHeight: number;
};

/** 使用单份选择遮罩合成深度正确的静态深红外光晕，不修改模型表面。 */
export class SceneSelectionHighlightLayer extends SelectionOutlineLayer {
  readonly color = Color3.FromHexString(SCENE_SELECTION_GLOW_COLOR_HEX);
  readonly blurPixels = SCENE_SELECTION_GLOW_BLUR_PIXELS;
  readonly isAnimated = false;
  readonly affectsSurface = false;
  private fallbackToBuiltInOutline = false;
  private fallbackMergeResetPending = false;
  private fallbackReported = false;
  private disposed = false;
  private readonly onFallback: (message: string) => void;
  private readonly thinSelectionLayer: SelectionHighlightThinLayer;
  private readonly createBuiltInMergeEffect: () => Effect;
  private readonly composeBuiltInMergeEffect: (effect: Effect, renderIndex: number) => void;

  constructor(
    name: string,
    scene: Scene,
    onFallback: (message: string) => void = () => undefined,
  ) {
    registerSceneSelectionHighlightShaders();
    super(name, scene, {
      useDepthOcclusion: true,
      outlineMethod: Constants.OUTLINELAYER_SAMPLING_OCTADIRECTIONAL,
    });
    this.onFallback = onFallback;
    this.outlineColor = this.color;
    this.outlineThickness = SCENE_SELECTION_FALLBACK_OUTLINE_THICKNESS_PIXELS;
    this.useDepthOcclusion = true;
    this.occlusionStrength = 1;
    this.occlusionThreshold = SCENE_SELECTION_OCCLUSION_THRESHOLD;

    this.thinSelectionLayer = this._thinEffectLayer as unknown as SelectionHighlightThinLayer;
    this.createBuiltInMergeEffect = this.thinSelectionLayer._createMergeEffect.bind(this.thinSelectionLayer);
    this.composeBuiltInMergeEffect = this.thinSelectionLayer._internalCompose.bind(this.thinSelectionLayer);
    this.thinSelectionLayer._createMergeEffect = () => (
      this.fallbackToBuiltInOutline
        ? this.createBuiltInMergeEffect()
        : this.createSelectionMergeEffect()
    );
    this.thinSelectionLayer._numInternalDraws = () => this.getInternalDrawCount();
    this.thinSelectionLayer._internalCompose = (effect, renderIndex) => {
      if (this.fallbackToBuiltInOutline) {
        this.composeBuiltInMergeEffect(effect, renderIndex);
        return;
      }
      this.composeSelectionGlow(effect);
    };
  }

  setSelectionGroups(groups: readonly (readonly AbstractMesh[])[]): void {
    super.clearSelection();
    for (const meshes of groups) {
      if (meshes.length > 0) this.addSelection([...meshes]);
    }
  }

  override isLayerReady(): boolean {
    this.resetFallbackMergeEffects();
    return super.isLayerReady();
  }

  override render(): void {
    this.resetFallbackMergeEffects();
    super.render();
  }

  private getInternalDrawCount(): number {
    return 1;
  }

  private resetFallbackMergeEffects(): void {
    if (!this.fallbackMergeResetPending) return;
    this.fallbackMergeResetPending = false;
    this.thinSelectionLayer._disposeMergeEffects();
  }

  private composeSelectionGlow(effect: Effect): void {
    this.thinSelectionLayer.bindTexturesForCompose(effect);
    effect.setFloat2(
      'screenSize',
      this.thinSelectionLayer.textureWidth,
      this.thinSelectionLayer.textureHeight,
    );
    effect.setColor3('glowColor', this.color);
    effect.setFloat('glowRadius', this.blurPixels);
    effect.setFloat('glowIntensity', SCENE_SELECTION_GLOW_INTENSITY);
    effect.setFloat('occlusionStrength', this.occlusionStrength);
    effect.setFloat('occlusionThreshold', this.occlusionThreshold);
    effect.setFloat('reverseDepth', this._engine.useReverseDepthBuffer ? 1 : 0);
    const previousStencilBuffer = this._engine.getStencilBuffer();
    this._engine.setStencilBuffer(false);
    this._engine.drawElementsType(Constants.MATERIAL_TriangleFillMode, 0, 6);
    this._engine.setStencilBuffer(previousStencilBuffer);
  }

  private createSelectionMergeEffect(): Effect {
    return this._engine.createEffect(
      { vertex: 'glowMapMerge', fragment: SCENE_SELECTION_HIGHLIGHT_SHADER_NAME },
      [VertexBuffer.PositionKind],
      [
        'screenSize',
        'glowColor',
        'glowRadius',
        'glowIntensity',
        'occlusionStrength',
        'occlusionThreshold',
        'reverseDepth',
      ],
      ['maskSampler', 'depthSampler'],
      '',
      undefined,
      undefined,
      (failedEffect, errors) => {
        this.activateBuiltInOutlineFallback(
          `深红光晕着色器初始化失败，已降级为深红色细描边：${errors || failedEffect.getCompilationError() || '未知着色器错误。'}`,
        );
      },
      undefined,
      this._shaderLanguage,
      async () => {
        if (this._shaderLanguage === ShaderLanguage.WGSL) {
          await import('@babylonjs/core/ShadersWGSL/glowMapMerge.vertex.js');
        } else {
          await import('@babylonjs/core/Shaders/glowMapMerge.vertex.js');
        }
      },
    );
  }

  private activateBuiltInOutlineFallback(message: string): void {
    if (this.disposed || this.fallbackToBuiltInOutline) return;
    this.fallbackToBuiltInOutline = true;
    this.fallbackMergeResetPending = true;
    this.reportFallback(message);
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
    releaseSceneSelectionDepthRendererIfUnused(this._scene);
  }

  private reportFallback(message: string): void {
    if (this.fallbackReported) return;
    this.fallbackReported = true;
    this.onFallback(message);
  }
}

export function createSceneSelectionHighlightLayer(
  scene: Scene,
  name = SCENE_SELECTION_HIGHLIGHT_LAYER_NAME,
  onFallback: (message: string) => void = () => undefined,
): SceneSelectionHighlightLayer {
  return new SceneSelectionHighlightLayer(name, scene, onFallback);
}

export function setSceneSelectionHighlightGroups(
  layer: Pick<SceneSelectionHighlightLayer, 'setSelectionGroups'>,
  groups: readonly (readonly AbstractMesh[])[],
): void {
  layer.setSelectionGroups(groups);
}

export function clearSceneSelectionHighlight(
  layer: Pick<SceneSelectionHighlightLayer, 'clearSelection'>,
  scene: Scene,
): void {
  layer.clearSelection();
  releaseSceneSelectionDepthRendererIfUnused(scene);
}
