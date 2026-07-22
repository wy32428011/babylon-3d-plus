import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./bonesDeclaration-oDxSsnww.js";import{n,t as r}from"./bakedVertexAnimation-7XIMgH6x.js";import{t as i}from"./morphTargetsVertexGlobalDeclaration-D6da8uHC.js";import{t as a}from"./morphTargetsVertexDeclaration-DQIU8BV5.js";import{t as o}from"./instancesDeclaration-CJBvtBV5.js";import{t as s}from"./morphTargetsVertexGlobal-Bo-wqe4M.js";import{t as c}from"./morphTargetsVertex-Uz52QWNe.js";import{t as l}from"./instancesVertex-C-FoRQR1.js";import{t as u}from"./bonesVertex-BZbvWQw2.js";var d=`pickingVertexShader`,f=`attribute vec3 position;
#if defined(INSTANCES)
attribute float instanceMeshID;
#endif
#include<bonesDeclaration>
#include<bakedVertexAnimationDeclaration>
#include<morphTargetsVertexGlobalDeclaration>
#include<morphTargetsVertexDeclaration>[0..maxSimultaneousMorphTargets]
#include<instancesDeclaration>
uniform mat4 viewProjection;
#if defined(INSTANCES)
flat varying float vMeshID;
#endif
void main(void) {vec3 positionUpdated=position;
#include<morphTargetsVertexGlobal>
#include<morphTargetsVertex>[0..maxSimultaneousMorphTargets]
#include<instancesVertex>
#include<bonesVertex>
#include<bakedVertexAnimation>
vec4 worldPos=finalWorld*vec4(positionUpdated,1.0);gl_Position=viewProjection*worldPos;
#if defined(INSTANCES)
vMeshID=instanceMeshID;
#endif
}
`;e.ShadersStore[d]||(e.ShadersStore[d]=f);var p=[t,n,i,a,o,s,c,l,u,r];for(let t of p)e.IncludesShadersStore[t.name]||(e.IncludesShadersStore[t.name]=t.shader);var m={name:d,shader:f};export{m as t};