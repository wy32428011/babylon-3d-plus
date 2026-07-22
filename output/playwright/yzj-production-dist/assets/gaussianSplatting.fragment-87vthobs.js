import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./clipPlaneFragmentDeclaration-LJdlhFDo.js";import{t as n}from"./clipPlaneFragment-B_IgbgTE.js";import{t as r}from"./logDepthDeclaration-3gXGtHbI.js";import{t as i}from"./fogFragmentDeclaration-kXoGw5iI.js";import{t as a}from"./logDepthFragment-C5lxT4l1.js";import{t as o}from"./fogFragment-CKCGTcJi.js";import{t as s}from"./gaussianSplattingFragmentDeclaration-DuANFXRd.js";var c=`gaussianSplattingPixelShader`,l=`#include<clipPlaneFragmentDeclaration>
#include<logDepthDeclaration>
#include<fogFragmentDeclaration>
varying vec4 vColor;varying vec2 vPosition;
#define CUSTOM_FRAGMENT_DEFINITIONS
#include<gaussianSplattingFragmentDeclaration>
void main () {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
#include<clipPlaneFragment>
vec4 finalColor=gaussianColor(vColor);
#define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR
gl_FragColor=finalColor;
#define CUSTOM_FRAGMENT_MAIN_END
}
`;e.ShadersStore[c]||(e.ShadersStore[c]=l);var u=[t,r,i,a,o,s,n];for(let t of u)e.IncludesShadersStore[t.name]||(e.IncludesShadersStore[t.name]=t.shader);var d={name:c,shader:l};export{d as gaussianSplattingPixelShader};