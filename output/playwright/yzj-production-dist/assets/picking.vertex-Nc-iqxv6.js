import{t as e}from"./shaderStore-D-XQlhUT.js";import{t}from"./bonesDeclaration-CyjXpdlz.js";import{t as n}from"./bakedVertexAnimationDeclaration-C-g0vyVW.js";import{t as r}from"./morphTargetsVertexGlobalDeclaration-B4Uhgd1q.js";import{t as i}from"./morphTargetsVertexDeclaration-D7nvpAib.js";import{t as a}from"./instancesDeclaration-DsiFqYXH.js";import{t as o}from"./morphTargetsVertexGlobal-CH8bCQ4f.js";import{t as s}from"./morphTargetsVertex-wwizyQUK.js";import{t as c}from"./instancesVertex-Dty6qjVO.js";import{t as l}from"./bonesVertex-3u5jVDJW.js";import{t as u}from"./bakedVertexAnimation-CP3BNGXM.js";var d=`pickingVertexShader`,f=`attribute position: vec3f;
#if defined(INSTANCES)
attribute instanceMeshID: f32;
#endif
#include<bonesDeclaration>
#include<bakedVertexAnimationDeclaration>
#include<morphTargetsVertexGlobalDeclaration>
#include<morphTargetsVertexDeclaration>[0..maxSimultaneousMorphTargets]
#include<instancesDeclaration>
uniform viewProjection: mat4x4f;
#if defined(INSTANCES)
flat varying vMeshID: f32;
#endif
@vertex
fn main(input : VertexInputs)->FragmentInputs {var positionUpdated: vec3f=vertexInputs.position;
#include<morphTargetsVertexGlobal>
#include<morphTargetsVertex>[0..maxSimultaneousMorphTargets]
#include<instancesVertex>
#include<bonesVertex>
#include<bakedVertexAnimation>
var worldPos: vec4f=finalWorld*vec4f(positionUpdated,1.0);vertexOutputs.position=uniforms.viewProjection*worldPos;
#if defined(INSTANCES)
vertexOutputs.vMeshID=vertexInputs.instanceMeshID;
#endif
}
`;e.ShadersStoreWGSL[d]||(e.ShadersStoreWGSL[d]=f);var p=[t,n,r,i,a,o,s,c,l,u];for(let t of p)e.IncludesShadersStoreWGSL[t.name]||(e.IncludesShadersStoreWGSL[t.name]=t.shader);var m={name:d,shader:f};export{m as t};