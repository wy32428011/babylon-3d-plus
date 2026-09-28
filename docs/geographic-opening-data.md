# 地理开场动画数据来源

## 当前 HTML 参考模板（2026-09-28）

当前 `reference-huishan` 模板使用用户提供的 `zd_digital_twin_opening.html` 内嵌的 9 张参考画面及 1 张地球纹理图。素材完整提取为 `src/runtime/opening/reference/assets/` 中的 WebP，随编辑器与 Viewer 打包；播放期间不请求在线地图服务。球面展开、镜头过渡和动态飞线绘制依据该文件模块化接入。

飞线使用原 HTML 的归一化画面坐标 `(x,y)`，左上角为 `(0,0)`，右下角为 `(1,1)`，不是经纬度。默认全球 40 条、国内 34 条，属于展示示意。图中行政注记、定位和部分公司文字已经烘焙到图片，修改文案配置不会改写图片像素。此素材来源说明不赋予参考图片原文件以外的许可，也不把下方历史开源地理数据的许可套用于参考图片。

末段淡出覆盖图层，直接显露一直运行的业务 canvas 和已保存相机，不重载或重建业务场景。惠山参考画面和真实业务模型并无测绘配准；该衔接为视觉过渡。新演示最后展示的是自建园区示意模型。

## 历史地理模板数据

以下数据保留给原地理绘制模块和既有测试；当前参考模板不使用这些边界生成底图。

`src/runtime/opening/data/` 中的 JSON 是随应用打包的展示数据，不在播放期间请求外网。数据取得日期：2026-09-27。所有边界来自下列源数据，未手绘或伪造行政区划；仅保留目标几何，原始选区坐标保留六位小数，国界与省界保留五位小数。

| 内容 | 来源及版本 | 许可 |
| --- | --- | --- |
| 全球大陆 | [Natural Earth 110m land](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson) | Public Domain，见 [Terms of Use](https://www.naturalearthdata.com/about/terms-of-use/) |
| 全球国界 | [Natural Earth 110m admin 0 countries](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson)，177 个区域，保存于 `worldCountryBoundaries.json` | Public Domain |
| 中国 | [geoBoundaries CHN ADM0](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM0/)，`CHN-ADM0-351020`，表示年份 2019，源 geoBoundaries / Wikimedia Commons | Public Domain |
| 江苏 | [geoBoundaries CHN ADM1](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/)，`CHN-ADM1-43563684`，表示年份 2019，`Jiangsu Province` | Public Domain |
| 中国省级边界 | 同上 CHN ADM1 固定源提交 `9469f09`，34 个一级行政区域，保存于 `chinaProvinceBoundaries.json` | Public Domain |
| 无锡 | [OpenStreetMap relation 4430942](https://www.openstreetmap.org/relation/4430942)，经 Nominatim 导出的无锡市 Polygon，2026-09-27 获取 | © OpenStreetMap contributors，ODbL 1.0 |
| 惠山 | [geoBoundaries CHN ADM3](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM3/)，`CHN-ADM3-62558664`，表示年份 2017，`Huishan District`，源 Lee Beryman / OpenStreetMap | © OpenStreetMap contributors，ODbL 1.0 |

geoBoundaries 取得的简化边界固定来自提交 `9469f09`：`releaseData/gbOpen/CHN/ADM{0,1,3}/geoBoundaries-CHN-ADM{0,1,3}_simplified.geojson`。ODbL 数据衍生部分（`wuxi`、`huishan`）继续按 [Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供；包内 JSON 同时就是可机器读取的衍生几何数据，分发时保留此来源与许可说明。OpenStreetMap 使用说明见 [版权与许可](https://www.openstreetmap.org/copyright)。

## 展示边界

- 展示的是来自开源数据的地理轮廓和示意线路，不等于实时 GIS、现行官方行政区划认证、航班数据或业务覆盖证明。源年份不同，可能存在边界差异。
- 默认飞线出发点为惠山区内示意坐标 `120.30°E, 31.68°N`，不是业务园区的测绘坐标。具体项目可修改落点及线路目的地。
- 末段通过同一 Canvas 内的覆盖场景淡出显露已就绪的业务场景。没有业务模型地理锚点、朝向及比例时，不宣称完成地理精确配准。
- 世界地图采用等距经纬展示，亚洲置于中心区域；参考图版中心经度为 `150°E`、切缝为 `30°W`，减少美洲被切开的情况。球面展开具有预期的视觉形变；不宣称等距无变形。
- 首版固定中国、江苏、无锡、惠山叙事层级；改变飞线落点不会自动替换行政区划下钻路径。
- 地图上的细密光点、局部短连线、背景网络和网格采用固定随机种子程序绘制，是装饰纹理，不代表真实城市人口、夜间灯光测量或业务覆盖。若干发光聚集区使用常见城市经纬度布局，仍为示意。
- 世界纹理与球面纹理共用同一份经纬度栅格；省级和国界线使用上述真实边界数据，不用随机线条冒充行政边界。纹理只在创建开场时生成，每帧只更新几何变形、镜头及透明度。
- 展开后的地图边缘柔和淡出，南纬 52–66°的区域逐渐淡出以避免南极在平铺视图底部形成突兀横条；旋转球面阶段保留完整海陆纹理与球体轮廓。

## 本地演示

启动项目已有 Vite 开发服务器后访问 `/tests/fixtures/geographicOpeningDemo.html`。可追加 `?seek=6.5` 定位到某秒并暂停；页面支持暂停、继续、跳过与重播。演示下方业务园区是本地构造的示意模型，不代表用户真实业务场景已经验收。
