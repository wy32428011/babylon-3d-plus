import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./helperFunctions-BXbvU0Ia.js";import{t as n}from"./clipPlaneFragmentDeclaration-LJdlhFDo.js";import{t as r}from"./clipPlaneFragment-B_IgbgTE.js";import{t as i}from"./logDepthDeclaration-3gXGtHbI.js";import{t as a}from"./imageProcessingDeclaration-uVLyFKzl.js";import{t as o}from"./imageProcessingFunctions-Gwc0E_Xa.js";import{t as s}from"./fogFragmentDeclaration-kXoGw5iI.js";import{t as c}from"./logDepthFragment-C5lxT4l1.js";import{t as l}from"./fogFragment-CKCGTcJi.js";var u=`particlesPixelShader`,d=`#ifdef LOGARITHMICDEPTH
#extension GL_EXT_frag_depth : enable
#endif
varying vec2 vUV;varying vec4 vColor;uniform vec4 textureMask;uniform sampler2D diffuseSampler;
#include<clipPlaneFragmentDeclaration>
#include<imageProcessingDeclaration>
#include<logDepthDeclaration>
#include<helperFunctions>
#include<imageProcessingFunctions>
#ifdef RAMPGRADIENT
varying vec4 remapRanges;uniform sampler2D rampSampler;
#endif
#include<fogFragmentDeclaration>
#define CUSTOM_FRAGMENT_DEFINITIONS
void main(void) {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
#include<clipPlaneFragment>
vec4 textureColor=texture2D(diffuseSampler,vUV);vec4 baseColor=(textureColor*textureMask+(vec4(1.,1.,1.,1.)-textureMask))*vColor;
#ifdef RAMPGRADIENT
float alpha=baseColor.a;float remappedColorIndex=clamp((alpha-remapRanges.x)/remapRanges.y,0.0,1.0);vec4 rampColor=texture2D(rampSampler,vec2(1.0-remappedColorIndex,0.));baseColor.rgb*=rampColor.rgb;float finalAlpha=baseColor.a;baseColor.a=clamp((alpha*rampColor.a-remapRanges.z)/remapRanges.w,0.0,1.0);
#endif
#ifdef BLENDMULTIPLYMODE
float sourceAlpha=vColor.a*textureColor.a;baseColor.rgb=baseColor.rgb*sourceAlpha+vec3(1.0)*(1.0-sourceAlpha);
#endif
#include<logDepthFragment>
#include<fogFragment>(color,baseColor)
#ifdef IMAGEPROCESSINGPOSTPROCESS
baseColor.rgb=toLinearSpace(baseColor.rgb);
#else
#ifdef IMAGEPROCESSING
baseColor.rgb=toLinearSpace(baseColor.rgb);baseColor=applyImageProcessing(baseColor);
#endif
#endif
gl_FragColor=baseColor;
#define CUSTOM_FRAGMENT_MAIN_END
}`;e.ShadersStore[u]||(e.ShadersStore[u]=d);var f=[n,a,i,t,o,s,r,c,l];for(let t of f)e.IncludesShadersStore[t.name]||(e.IncludesShadersStore[t.name]=t.shader);var p={name:u,shader:d};export{p as t};