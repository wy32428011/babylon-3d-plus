import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';
import boundaries from './data/geographicBoundaries.json';
import countryBoundaries from './data/worldCountryBoundaries.json';
import provinceBoundaries from './data/chinaProvinceBoundaries.json';
import { MAP_CENTER_LONGITUDE, projectGeographicPoint, smooth } from './geographicOpeningMath';
import { drawHotspots, drawLandIllumination, drawTextureGrid, geographicPath, geometryPolygons, seededRandom, strokeElectricBoundary } from './geographicOpeningTexture';
import type { GeographicGeometry as Geometry } from './geographicOpeningTexture';

export type RegionName = 'china' | 'jiangsu' | 'wuxi' | 'huishan';
export const REGION_LABELS: Record<RegionName, string> = {china: '中国', jiangsu: '江苏省', wuxi: '无锡市', huishan: '惠山区'};
const RAD = Math.PI / 180;
const geometries = boundaries as unknown as Record<RegionName, Geometry> & {world: Geometry[]};
const polygons = geometryPolygons;
const provinces = provinceBoundaries as {name:string;geometry:Geometry}[];
const countries = countryBoundaries as {name:string;geometry:Geometry}[];

export function regionBounds(name: RegionName) {
  const points = polygons(geometries[name]).flat(2);
  const xs = points.map(p => projectGeographicPoint(p[0], p[1], 1)[0]);
  const ys = points.map(p => p[1] * RAD);
  return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
}

export function emissiveMaterial(scene: Scene, name: string, color: Color3, alpha = 1) {
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = color;
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  material.alpha = alpha;
  material.backFaceCulling = false;
  return material;
}

export function createWorldVisual(scene: Scene) {
  const width = 4096, height = 2048;
  const texture = new DynamicTexture('opening-world-map', {width, height}, scene, false);
  const context = texture.getContext() as CanvasRenderingContext2D;
  const ocean = context.createRadialGradient(width * .5, height * .42, 0, width * .5, height * .5, width * .7);
  ocean.addColorStop(0, '#041831'); ocean.addColorStop(.5, '#020e20'); ocean.addColorStop(1, '#010714');
  context.fillStyle = ocean; context.fillRect(0, 0, width, height);
  drawTextureGrid(context, width, height, 32, .14);
  const project = (p: number[]): [number, number] => [(((p[0] - MAP_CENTER_LONGITUDE + 540) % 360) / 360) * width, (90 - p[1]) / 180 * height];
  const land = new Path2D();
  for (const geometry of geometries.world) land.addPath(geographicPath(geometry, project, width));
  drawLandIllumination(context, land, {x:0,y:0,width,height}, {seed:27092026,points:70000,intensity:.92,spacing:24});
  context.strokeStyle = 'rgba(18,114,212,.68)'; context.lineWidth = 1.15;
  context.stroke(land);
  context.strokeStyle = 'rgba(34,129,221,.5)'; context.lineWidth = .95;
  for (const country of countries) context.stroke(geographicPath(country.geometry, project, width));
  // 密集点仅为装饰；核心发光点采用常见城市经纬度形成有辨识度的区域分布。
  const cities = [[116.4,39.9],[121.47,31.23],[113.26,23.13],[104.06,30.67],[114.3,30.59],[139.69,35.68],[126.98,37.56],[103.82,1.35],[100.5,13.76],[77.2,28.61],[72.87,19.08],[55.27,25.2],[28.97,41.01],[2.35,48.86],[-.13,51.5],[13.4,52.52],[12.49,41.89],[37.61,55.75],[-74,40.71],[-118.24,34.05],[-87.63,41.88],[-122.42,37.77],[-99.13,19.43],[-46.63,-23.55],[-58.38,-34.6],[151.21,-33.87],[144.96,-37.81],[18.42,-33.92],[31.23,30.04]];
  drawHotspots(context, land, cities.map(project), 24, 127);
  const china = geographicPath(geometries.china, project, width);
  context.save(); context.clip(china, 'evenodd');
  context.fillStyle = 'rgba(7,96,188,.22)'; context.fillRect(0,0,width,height);
  context.strokeStyle = 'rgba(92,191,255,.85)'; context.lineWidth = 1.35;
  for (const province of provinces) context.stroke(geographicPath(province.geometry, project, width));
  context.restore();
  strokeElectricBoundary(context, china, 2.1, 24);
  // Canvas 原点在左上；Babylon 平面和本模块经纬网 UV 均以左下为原点。
  texture.update(true);
  const mesh = new Mesh('opening-morphing-earth', scene);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [], colors: number[] = [], edgeOpacity: number[] = [];
  const coordinates: [number, number][] = [];
  const columns = 180, rows = 90;
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const longitude = MAP_CENTER_LONGITUDE - 180 + column / columns * 359.999999;
    const latitude = 90 - row / rows * 180;
    coordinates.push([longitude, latitude]); positions.push(...projectGeographicPoint(longitude, latitude, 0));
    uvs.push(column / columns, 1 - row / rows);
    colors.push(1,1,1,1);
    const horizontalFade = smooth(Math.min(column / columns, 1 - column / columns) / .025);
    // 只在展开成平面时软化边缘；球面保持完整，南极数据仍保留在原始纹理内。
    edgeOpacity.push(horizontalFade * smooth((90 - latitude) / 14) * smooth((latitude + 66) / 14));
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = row * (columns + 1) + column, b = a + columns + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData(); data.positions = positions; data.indices = indices; data.normals = normals; data.uvs = uvs; data.colors = colors;
  data.applyToMesh(mesh, true);
  const material = emissiveMaterial(scene, 'opening-earth-material', Color3.White());
  material.diffuseTexture = texture; material.emissiveTexture = texture;
  // 球面展开中会经过不同朝向的曲面，沿用双面显示并写入深度，避免地图被剔除。
  material.backFaceCulling = false;
  material.forceDepthWrite = true;
  mesh.material = material;
  mesh.hasVertexAlpha = true;
  mesh.useVertexColors = true;
  mesh.alwaysSelectAsActiveMesh = true;
  let previousUnfold = -1, previousRotation = -100;
  return {mesh, material, update(unfold: number, rotation: number) {
    if (unfold === previousUnfold && rotation === previousRotation) return;
    coordinates.forEach(([longitude, latitude], index) => {
      const point = projectGeographicPoint(longitude, latitude, unfold, rotation);
      positions[index * 3] = point[0]; positions[index * 3 + 1] = point[1]; positions[index * 3 + 2] = point[2];
    });
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
    if (unfold !== previousUnfold) {
      edgeOpacity.forEach((alpha, index) => { colors[index * 4 + 3] = 1 - unfold + unfold * alpha; });
      mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
    }
    previousUnfold = unfold; previousRotation = rotation;
  }};
}

export function createRegionVisual(scene: Scene, name: RegionName) {
  const bounds = regionBounds(name);
  const padding = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.055;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;
  const size = 1536;
  const texture = new DynamicTexture(`opening-${name}-boundary`, {width:size,height:size}, scene, false);
  const context = texture.getContext() as CanvasRenderingContext2D;
  context.clearRect(0,0,size,size);
  const project = (p: number[]): [number, number] => {
    const point = projectGeographicPoint(p[0], p[1], 1);
    return [(point[0] - bounds.minX + padding) / width * size, (bounds.maxY + padding - point[1]) / height * size];
  };
  const region = geographicPath(geometries[name], project);
  drawLandIllumination(context, region, {x:0,y:0,width:size,height:size}, {seed:9217+name.length,points:18000,intensity:1.08,spacing:32});
  if (name === 'china') {
    context.save(); context.clip(region, 'evenodd');
    context.strokeStyle = 'rgba(85,181,255,.88)'; context.lineWidth = 1.6;
    for (const province of provinces) context.stroke(geographicPath(province.geometry, project));
    context.restore();
  }
  strokeElectricBoundary(context, region, 2.1, 28);
  if (name !== 'huishan') {
    const next = ({china:'jiangsu', jiangsu:'wuxi', wuxi:'huishan'} as const)[name];
    const focus = geographicPath(geometries[next], project);
    context.fillStyle = 'rgba(14,120,238,.32)'; context.fill(focus, 'evenodd');
    strokeElectricBoundary(context, focus, 2.2, 20);
  }
  texture.hasAlpha = true; texture.update(true);
  const material = emissiveMaterial(scene, `opening-${name}-material`, Color3.White());
  material.diffuseTexture = texture; material.emissiveTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  const mesh = MeshBuilder.CreatePlane(`opening-${name}`, {width,height,sideOrientation:Mesh.DOUBLESIDE}, scene);
  mesh.position.set((bounds.minX+bounds.maxX)/2,(bounds.minY+bounds.maxY)/2,-0.004 - ['china','jiangsu','wuxi','huishan'].indexOf(name)*0.002);
  mesh.material = material;
  mesh.setEnabled(false);
  return {mesh,material,bounds};
}

export function createStarfield(scene: Scene) {
  const lines: Vector3[][] = [], colors: Color4[][] = [];
  let seed = 20927;
  const random = () => {seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for (let i=0;i<110;i++) {
    const x=(random()-.5)*15, y=(random()-.5)*9, radius=.002+random()*.004;
    lines.push([new Vector3(x-radius,y,2),new Vector3(x+radius,y,2)]);
    const c=new Color4(.1,.38,.74,.12+random()*.3); colors.push([c,c]);
  }
  return MeshBuilder.CreateLineSystem('opening-stars',{lines,colors},scene);
}

/** 透明科技背景；由调用方固定于相机，避免下钻时网格被无限放大。 */
export function createNetworkBackdrop(scene: Scene) {
  const width = 2048, height = 1280;
  const texture = new DynamicTexture('opening-network-backdrop', {width,height}, scene, false);
  const context = texture.getContext() as CanvasRenderingContext2D;
  const random = seededRandom(20260927);
  context.clearRect(0,0,width,height);
  drawTextureGrid(context,width,height,44,.12);
  const centerX=width*.5,centerY=height*1.6;
  const glow=context.createRadialGradient(centerX,centerY,height*.66,centerX,centerY,height*1.12);
  glow.addColorStop(0,'rgba(0,35,112,0)');glow.addColorStop(.55,'rgba(0,65,160,.04)');glow.addColorStop(.85,'rgba(0,118,244,.22)');glow.addColorStop(1,'rgba(0,20,80,0)');
  context.fillStyle=glow;context.fillRect(0,0,width,height);
  context.strokeStyle='rgba(29,142,255,.22)';context.lineWidth=1;
  for(let ring=0;ring<7;ring++){
    context.beginPath();context.ellipse(centerX,centerY,width*.73+ring*14,height*.82+ring*14,0,Math.PI,Math.PI*2);context.stroke();
  }
  context.shadowColor='#008cff';context.shadowBlur=24;
  context.strokeStyle='rgba(72,187,255,.82)';context.lineWidth=2;
  context.beginPath();context.ellipse(centerX,centerY,width*.77,height*.85,0,Math.PI,Math.PI*2);context.stroke();context.shadowBlur=0;
  const nodes=Array.from({length:85},()=>({x:random()*width,y:random()*height}));
  context.strokeStyle='rgba(14,121,231,.3)';context.lineWidth=.8;context.beginPath();
  nodes.forEach((node,index)=>{
    const next=nodes[(index+1)%nodes.length];
    if(Math.hypot(node.x-next.x,node.y-next.y)<210){context.moveTo(node.x,node.y);context.lineTo(next.x,next.y);}
  });
  context.stroke();
  for(const node of nodes){
    context.fillStyle='rgba(40,161,255,.65)';context.fillRect(node.x,node.y,1.4,1.4);
    if(node.y>height*.76){context.strokeStyle='rgba(33,146,255,.12)';context.beginPath();context.moveTo(node.x,node.y);context.lineTo(node.x,node.y-32-random()*90);context.stroke();}
  }
  texture.hasAlpha=true;texture.update(true);
  const material=emissiveMaterial(scene,'opening-network-backdrop-material',Color3.White());
  material.diffuseTexture=texture;material.emissiveTexture=texture;material.useAlphaFromDiffuseTexture=true;
  const mesh=MeshBuilder.CreatePlane('opening-network-backdrop',{width:12,height:7.5,sideOrientation:Mesh.DOUBLESIDE},scene);
  mesh.position.z=2;mesh.material=material;
  return {mesh,material,update(opacity:number){material.alpha=Math.max(0,Math.min(1,opacity));mesh.setEnabled(opacity>0);}};
}
