import{t as e}from"./shaderStore-D-XQlhUT.js";var t=`mrtFragmentDeclaration`,n=`#if defined(WEBGL2) || defined(WEBGPU) || defined(NATIVE)
layout(location=0) out vec4 glFragData[{X}];
#endif
`;e.IncludesShadersStore[t]||(e.IncludesShadersStore[t]=n);var r={name:t,shader:n};export{r as t};