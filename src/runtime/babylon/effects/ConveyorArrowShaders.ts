import type { ConveyorArrowEffectKind } from '../../../editor/model/components';

export const CONVEYOR_ARROW_STYLE_IDS: Record<ConveyorArrowEffectKind, number> = {
  'conveyor-arrow-single': 0,
  'conveyor-arrow-chevron': 1,
  'conveyor-arrow-segmented': 2,
  'conveyor-arrow-ribbon': 3,
  'conveyor-arrow-double': 4,
  'conveyor-arrow-speed': 5,
};

/** 独立 EFF 与输送面共用轮廓；米空间距离保证不同长宽比下边缘光厚度稳定。 */
export const CONVEYOR_ARROW_GLSL = `

float caSegment(vec2 p, vec2 a, vec2 b) {
  vec2 d = b - a;
  return length(p - a - d * clamp(dot(p - a, d) / max(dot(d,d), 0.000001), 0.0, 1.0));
}
float caBox(vec2 p, vec2 halfSize) {
  vec2 d = abs(p) - halfSize;
  return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}
float caHead(vec2 p, float start, float tip, float halfWidth) {
  p.y = abs(p.y);
  float edge = min(caSegment(p, vec2(start,halfWidth), vec2(tip,0.0)), caSegment(p, vec2(start,0.0), vec2(start,halfWidth)));
  float slope = halfWidth * (tip - p.x) / max(tip - start,0.0001);
  bool inside = p.x >= start && p.x <= tip && p.y <= slope;
  return inside ? -edge : edge;
}
float caLongArrow(vec2 p, vec2 size, float shaftWidth) {
  float tip = size.x * 0.45;
  float headStart = tip - min(size.y * 0.85, size.x * 0.3);
  float tail = -size.x * 0.46;
  float shaft = caBox(p - vec2((tail + headStart) * 0.5,0.0), vec2((headStart-tail)*0.5, size.y*shaftWidth));
  return min(shaft,caHead(p,headStart,tip,size.y*0.43));
}
float caChevron(vec2 p, float glyphLength, float halfWidth, float thickness) {
  p.y = abs(p.y);
  return caSegment(p,vec2(-glyphLength*0.5,halfWidth),vec2(glyphLength*0.5,0.0)) - thickness;
}
float caHexGrid(vec2 p) {
  vec2 cell = vec2(1.0,1.7320508);
  vec2 a = mod(p,cell) - cell*0.5;
  vec2 b = mod(p + cell*0.5,cell) - cell*0.5;
  vec2 h = dot(a,a) < dot(b,b) ? a : b;
  float boundary = max(dot(abs(h),vec2(0.8660254,0.5)),abs(h.y));
  return 1.0 - smoothstep(0.02,0.065,abs(boundary-0.48));
}
vec4 renderConveyorArrow(vec2 uv, vec2 size, float style, float count, float phase, vec3 color, vec3 edgeColor, float intensity, float opacity) {
  vec2 p = (uv - 0.5) * size;
  float soft = max(min(size.x,size.y) * 0.012, 0.0001);
  float distanceToShape = 100000.0;
  float detail = 0.0;
  float tailFade = 1.0;
  float pulse = 0.82 + 0.18*cos((uv.x - phase)*6.2831853);
  if (style < 0.5) {
    distanceToShape = caLongArrow(p,size,0.115);
    tailFade = mix(0.25,1.0,smoothstep(0.0,0.6,uv.x));
    detail = pow(max(0.0,cos((uv.x-phase)*6.2831853)),18.0)*0.35;
  } else if (style < 1.5) {
    float cell = size.x / count;
    float x = mod(p.x - phase*cell + cell*0.5,cell) - cell*0.5;
    distanceToShape = caChevron(vec2(x,p.y),min(cell*0.55,size.y*0.6),size.y*0.30,min(cell,size.y)*0.07);
    tailFade = smoothstep(0.0,0.06,uv.x)*(1.0-smoothstep(0.94,1.0,uv.x));
  } else if (style < 2.5) {
    float tip = size.x*0.45;
    float headStart = tip-min(size.y*0.85,size.x*0.3);
    float tail = -size.x*0.46;
    float gapLength = max(headStart-tail,size.x*0.1);
    float cell = gapLength / count;
    float x = mod(p.x-tail-phase*cell,cell)-cell*0.5;
    float dashes = caBox(vec2(x,p.y),vec2(cell*0.31,size.y*0.10));
    dashes = max(dashes, max(tail-p.x,p.x-headStart+cell*0.12));
    distanceToShape = min(dashes,caHead(p,headStart,tip,size.y*0.4));
    detail = 0.1;
  } else if (style < 3.5) {
    distanceToShape = caLongArrow(p,size,0.29);
    // 蜂窝横向周期为 1；每个动画周期移动整 12 格，避免相位回绕时纹理跳变。
    detail = caHexGrid((p-vec2(phase*size.y*0.09*12.0,0.0))/(size.y*0.09))*0.6;
    tailFade = mix(0.35,1.0,smoothstep(0.0,0.72,uv.x));
  } else if (style < 4.5) {
    float laneWidth = size.y*0.34;
    float across = abs(p.y)-size.y*0.25;
    float cell = size.x/count;
    float x = mod(p.x-phase*cell+cell*0.5,cell)-cell*0.5;
    float arrows = caChevron(vec2(x,across),min(cell*0.5,laneWidth*0.8),laneWidth*0.34,min(cell,laneWidth)*0.075);
    float guide = abs(across)-size.y*0.006;
    distanceToShape = min(arrows,guide);
    detail = (1.0-smoothstep(0.0,soft,arrows))*0.45;
    tailFade = smoothstep(0.0,0.06,uv.x)*(1.0-smoothstep(0.94,1.0,uv.x));
  } else {
    float tip = size.x*0.46;
    float headStart = tip-min(size.y*0.8,size.x*0.28);
    distanceToShape = caChevron(p-vec2((tip+headStart)*0.5,0.0),tip-headStart,size.y*0.42,size.y*0.025);
    float lanes = clamp(count*2.0,4.0,16.0);
    for (int i=0; i<16; i++) {
      float lane = float(i);
      if (lane < lanes) {
        float y = ((lane+0.5)/lanes-0.5)*size.y*0.72;
        float offset = fract(lane*0.6180339);
        float travel = fract(phase+offset);
        float streakLength = size.x*(0.12+0.13*fract(lane*0.381966));
        float center = mix(-size.x*0.47-streakLength,headStart+streakLength,travel);
        float streak = caBox(p-vec2(center,y),vec2(streakLength,size.y*0.007));
        streak = max(streak,max(-size.x*0.47-p.x,p.x-headStart));
        distanceToShape = min(distanceToShape,streak);
      }
    }
    tailFade = mix(0.24,1.0,smoothstep(0.0,0.8,uv.x));
    detail = 0.28;
  }
  float core = 1.0-smoothstep(-soft,soft,distanceToShape);
  float halo = (1.0-smoothstep(0.0,soft*6.0,distanceToShape))*0.22;
  float edge = 1.0-smoothstep(soft*0.35,soft*1.6,abs(distanceToShape));
  float alpha = max(core,halo)*opacity*tailFade;
  vec3 rgb = mix(color,edgeColor,edge*0.6) * intensity * (0.9+edge*0.8+detail) * pulse;
  return vec4(rgb,alpha);
}
`;
