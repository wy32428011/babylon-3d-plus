# 内置预过滤天空环境

本目录是 `public/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr` 的运行时派生产物，不替代或修改原图。

- 来源：Poly Haven — https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
- 原作者：Greg Zaal；天空编辑：Jarod Guest。
- 原始素材许可：CC0 — https://polyhaven.com/license
- 生成工具：`scripts/prepare-builtin-skybox-env.mjs`，需连接本地项目验证服务。
- 处理：Babylon.js 9.12.0、线性空间双线性全景转换、4096 采样预过滤、PNG/RGBD ENV。
- 规格：256、512、1024 像素/面；源 SHA、生成配方、产物 SHA 与大小见 `manifest.json`。

运行时直接加载所选 ENV，不再处理原始 HDR。PNG 图像无损压缩不代表 RGBD 编码与原始 Float32 数据逐值一致；画质由专项回归验证。
