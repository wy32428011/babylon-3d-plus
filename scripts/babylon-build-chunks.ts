/** 先隔离首屏 shader，再按语言合并延迟 shader；避免一个静态注册把全部 WGSL 拉进首屏。 */
export function babylonCodeSplitting() {
  return {
    // ShaderStore 同时被首屏业务引用，不能随延迟 shader 一起递归搬迁。
    includeDependenciesRecursively: false,
    groups: [
      { name: 'babylon-initial-shaders', test: /@babylonjs[\\/]core[\\/]Shaders(?:WGSL)?[\\/]/,
        tags: ['$initial' as const], priority: 20 },
      { name: 'babylon-glsl-shaders', test: /@babylonjs[\\/]core[\\/]Shaders[\\/]/, priority: 10 },
      { name: 'babylon-wgsl-shaders', test: /@babylonjs[\\/]core[\\/]ShadersWGSL[\\/]/, priority: 10 },
    ],
  };
}
