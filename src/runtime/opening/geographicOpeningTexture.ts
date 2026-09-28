/** 地图边界只来自数据；颗粒与网格是固定种子的装饰，不表示真实城市或业务覆盖。 */
export type GeographicGeometry = { type: string; coordinates: number[][][] | number[][][][] };
export type TextureProjector = (point: number[]) => [number, number];
export const geometryPolygons = (geometry: GeographicGeometry): number[][][][] => geometry.type === 'Polygon'
  ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];

export function geographicPath(geometry: GeographicGeometry, project: TextureProjector, wrapWidth?: number): Path2D {
  const path = new Path2D();
  for (const polygon of geometryPolygons(geometry)) {
    for (const offset of wrapWidth ? [-wrapWidth, 0, wrapWidth] : [0]) {
      for (const ring of polygon) {
        let previousX: number | undefined;
        ring.forEach((point, index) => {
          let [x, y] = project(point);
          if (wrapWidth && previousX !== undefined) {
            while (x - previousX > wrapWidth / 2) x -= wrapWidth;
            while (x - previousX < -wrapWidth / 2) x += wrapWidth;
          }
          previousX = x;
          if (index === 0) path.moveTo(x + offset, y); else path.lineTo(x + offset, y);
        });
        path.closePath();
      }
    }
  }
  return path;
}

export function seededRandom(initialSeed: number) {
  let seed = initialSeed >>> 0;
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

export function drawTextureGrid(context: CanvasRenderingContext2D, width: number, height: number, spacing: number, opacity = .14) {
  context.save();
  context.lineWidth = .75;
  context.strokeStyle = `rgba(24, 113, 201, ${opacity})`;
  context.beginPath();
  for (let x = 0; x <= width; x += spacing) { context.moveTo(x, 0); context.lineTo(x, height); }
  for (let y = 0; y <= height; y += spacing) { context.moveTo(0, y); context.lineTo(width, y); }
  context.stroke();
  context.strokeStyle = `rgba(26, 126, 224, ${opacity * 1.8})`;
  context.setLineDash([3, 8]);
  context.beginPath();
  for (let x = 0; x <= width; x += spacing * 4) { context.moveTo(x, 0); context.lineTo(x, height); }
  for (let y = 0; y <= height; y += spacing * 4) { context.moveTo(0, y); context.lineTo(width, y); }
  context.stroke();
  context.restore();
}

function drawLight(context: CanvasRenderingContext2D, x: number, y: number, radius: number, opacity: number) {
  const glow = context.createRadialGradient(x, y, 0, x, y, radius * 5);
  glow.addColorStop(0, `rgba(151,235,255,${opacity})`);
  glow.addColorStop(.16, `rgba(31,158,255,${opacity * .72})`);
  glow.addColorStop(.5, `rgba(18,112,255,${opacity * .2})`);
  glow.addColorStop(1, 'rgba(6,81,224,0)');
  context.fillStyle = glow;
  context.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
  context.fillStyle = `rgba(190,248,255,${opacity})`;
  context.fillRect(x - .65, y - .65, 1.3, 1.3);
}

/** 所有颗粒和短连线均裁剪在真实陆地内；只在建纹理时运行。 */
export function drawLandIllumination(context: CanvasRenderingContext2D, path: Path2D,
  bounds: { x: number; y: number; width: number; height: number }, options: { seed: number; points: number; intensity?: number; spacing?: number }) {
  const random = seededRandom(options.seed);
  const intensity = options.intensity ?? 1;
  context.save();
  context.clip(path, 'evenodd');
  const gradient = context.createLinearGradient(0, bounds.y, 0, bounds.y + bounds.height);
  gradient.addColorStop(0, intensity > 1 ? '#074782' : '#073464');
  gradient.addColorStop(.48, intensity > 1 ? '#083d82' : '#06316c');
  gradient.addColorStop(1, intensity > 1 ? '#05275d' : '#041c43');
  context.fillStyle = gradient;
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  drawTextureGrid(context, bounds.x + bounds.width, bounds.y + bounds.height, options.spacing ?? 32, .1 * intensity);
  for (let index = 0; index < options.points; index++) {
    const x = bounds.x + random() * bounds.width, y = bounds.y + random() * bounds.height;
    const radius = .8 + random() * 1.5;
    const brightness = (.12 + Math.pow(random(), 1.6) * .8) * intensity;
    context.fillStyle = `rgba(29,153,255,${brightness})`;
    context.fillRect(x, y, radius, radius);
    if (index % 211 === 0) drawLight(context, x, y, 1.1 + random() * 1.6, .35 * intensity);
  }
  // 短线构成局部网络肌理，长航线由运行层单独管理。
  context.strokeStyle = `rgba(58,145,239,${.15 * intensity})`;
  context.lineWidth = .7;
  context.beginPath();
  const links = Math.floor(options.points / 75);
  for (let index = 0; index < links; index++) {
    const x = bounds.x + random() * bounds.width, y = bounds.y + random() * bounds.height;
    const angle = random() * Math.PI * 2, length = 8 + random() * 33;
    context.moveTo(x, y); context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
  }
  context.stroke();
  context.restore();
}

export function strokeElectricBoundary(context: CanvasRenderingContext2D, path: Path2D, width: number, glow = 18) {
  context.save();
  context.lineJoin = 'round'; context.lineCap = 'round';
  context.shadowColor = '#008aff'; context.shadowBlur = glow;
  context.strokeStyle = 'rgba(0,126,255,.82)'; context.lineWidth = width * 3.4;
  context.stroke(path);
  context.shadowColor = '#21baff'; context.shadowBlur = glow * .65;
  context.strokeStyle = '#26bcff'; context.lineWidth = width * 1.7;
  context.stroke(path);
  context.shadowBlur = 0; context.strokeStyle = '#a9f6ff'; context.lineWidth = width * .6;
  context.stroke(path);
  context.restore();
}

export function drawHotspots(context: CanvasRenderingContext2D, land: Path2D,
  locations: Array<[number, number]>, radius: number, seed: number) {
  const random = seededRandom(seed);
  context.save(); context.clip(land, 'evenodd');
  for (const [x, y] of locations) {
    for (let point = 0; point < 85; point++) {
      const distance = Math.pow(random(), .7) * radius, angle = random() * Math.PI * 2;
      const px = x + Math.cos(angle) * distance, py = y + Math.sin(angle) * distance;
      context.fillStyle = `rgba(56,175,255,${.15 + random() * .65})`;
      context.fillRect(px, py, .7 + random(), .7 + random());
    }
    drawLight(context, x, y, 2.1, .8);
  }
  context.restore();
}
