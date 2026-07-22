import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./clipPlaneFragmentDeclaration-DYuu9Qqk.js";import{t as n}from"./clipPlaneFragment-F6cElb9_.js";import{t as r}from"./logDepthDeclaration-DYYUVTrx.js";import{t as i}from"./fogFragmentDeclaration-CWCikRBp.js";import{t as a}from"./logDepthFragment-CxtJswLx.js";import{t as o}from"./fogFragment-C9E3EVJj.js";import{t as s}from"./gaussianSplattingFragmentDeclaration-C-FAEfrX.js";var c=`gaussianSplattingPixelShader`,l=`#include<clipPlaneFragmentDeclaration>
#include<logDepthDeclaration>
#include<fogFragmentDeclaration>
varying vColor: vec4f;varying vPosition: vec2f;
#define CUSTOM_FRAGMENT_DEFINITIONS
#include<gaussianSplattingFragmentDeclaration>
@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
#include<clipPlaneFragment>
var finalColor: vec4f=gaussianColor(input.vColor,input.vPosition);
#define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR
fragmentOutputs.color=finalColor;
#define CUSTOM_FRAGMENT_MAIN_END
}
`;e.ShadersStoreWGSL[c]||(e.ShadersStoreWGSL[c]=l);var u=[t,r,i,a,o,s,n];for(let t of u)e.IncludesShadersStoreWGSL[t.name]||(e.IncludesShadersStoreWGSL[t.name]=t.shader);var d={name:c,shader:l};export{d as gaussianSplattingPixelShaderWGSL};