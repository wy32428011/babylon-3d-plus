import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./helperFunctions-s1JcGifL.js";import{t as n}from"./clipPlaneFragmentDeclaration-DYuu9Qqk.js";import{t as r}from"./clipPlaneFragment-F6cElb9_.js";import{t as i}from"./logDepthDeclaration-DYYUVTrx.js";import{t as a}from"./imageProcessingDeclaration-X2jNlw6a.js";import{t as o}from"./imageProcessingFunctions-DBcm1wbk.js";import{t as s}from"./fogFragmentDeclaration-CWCikRBp.js";import{t as c}from"./logDepthFragment-CxtJswLx.js";import{t as l}from"./fogFragment-C9E3EVJj.js";var u=`gpuRenderParticlesPixelShader`,d=`var diffuseSamplerSampler: sampler;var diffuseSampler: texture_2d<f32>;varying vUV: vec2f;varying vColor: vec4f;
#include<clipPlaneFragmentDeclaration>
#include<imageProcessingDeclaration>
#include<logDepthDeclaration>
#include<helperFunctions>
#include<imageProcessingFunctions>
#include<fogFragmentDeclaration>
@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
#include<clipPlaneFragment>
let textureColor: vec4f=textureSample(diffuseSampler,diffuseSamplerSampler,input.vUV);var baseColor: vec4f=textureColor*input.vColor;
#ifdef BLENDMULTIPLYMODE
let alpha: f32=input.vColor.a*textureColor.a;baseColor=vec4f(baseColor.rgb*alpha+vec3f(1.0)*(1.0-alpha),baseColor.a);
#endif
#include<logDepthFragment>
#include<fogFragment>(color,baseColor)
#ifdef IMAGEPROCESSINGPOSTPROCESS
baseColor=vec4f(toLinearSpaceVec3(baseColor.rgb),baseColor.a);
#else
#ifdef IMAGEPROCESSING
baseColor=vec4f(toLinearSpaceVec3(baseColor.rgb),baseColor.a);baseColor=applyImageProcessing(baseColor);
#endif
#endif
fragmentOutputs.color=baseColor;}
`;e.ShadersStoreWGSL[u]||(e.ShadersStoreWGSL[u]=d);var f=[n,a,i,t,o,s,r,c,l];for(let t of f)e.IncludesShadersStoreWGSL[t.name]||(e.IncludesShadersStoreWGSL[t.name]=t.shader);var p={name:u,shader:d};export{p as gpuRenderParticlesPixelShaderWGSL};