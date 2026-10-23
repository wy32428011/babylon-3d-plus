/** 保留 glTF 2.0 全部既有能力；扩展和材质适配器由官方 loader 按资源实际声明异步加载。 */
import "@babylonjs/loaders/glTF/glTFFileLoader.js";
import "@babylonjs/loaders/glTF/glTFValidation.js";
// 普通模型扫描仍接受 glTF 1.0 文本包，保留原完整入口的版本能力；环境 GLB 校验继续要求 2.0。
import "@babylonjs/loaders/glTF/1.0/index.js";
import "@babylonjs/loaders/glTF/2.0/glTFLoader.js";
import "@babylonjs/loaders/glTF/2.0/glTFLoaderAnimation.js";
import { registerBuiltInGLTFExtensions } from "@babylonjs/loaders/glTF/2.0/Extensions/dynamic.js";

// 工厂保留全部扩展名，loader 会等待实际用到的扩展；普通 PBR 不预先加载 FlowGraph、音频和 OpenPBR。
registerBuiltInGLTFExtensions();
