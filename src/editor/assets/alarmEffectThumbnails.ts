const shapes: Record<string, string> = {
  'model-color': '<path d="M49 18H108V59H49Z" fill="#ff3434"/><path d="M49 18l16-8h58l-15 8m0 0 15-8v40l-15 9"/>',
  'model-flash': '<path d="M57 20h48v38H57Z" fill="#ff442b"/><path d="m23 24 14 7-13 8m101-15 14 7-13 8M78 6v9m0 47v9" stroke-width="3"/>',
  'breathing-ring': '<ellipse cx="80" cy="45" rx="57" ry="17"/><ellipse cx="80" cy="45" rx="40" ry="11"/><path d="M64 17h31v28H64Z" fill="#222e3a"/>',
  'model-outline': '<path d="M53 19h55v39H53Zm0 0 16-10h55v40l-16 9m0-39 16-10M69 9v40l-16 9" stroke-width="3"/>',
  'warning-beacon': '<path d="M52 54h56v6H52Z" fill="#4b4e58"/><path d="M64 52V26a16 16 0 0 1 32 0v26Z" fill="#ff2424"/><path d="M43 17l12 6m50 0 12-6M80 2v8"/>',
  'alarm-icon': '<path d="M80 9 110 57H50Z" stroke-width="3" fill="#8c131366"/><path d="M80 26v14m0 6v3" stroke="#fff" stroke-width="4"/>',
  'light-pillar': '<path d="M67 57 72 7h16l6 50Z" fill="#ff242455"/><path d="M78 8v47m6-42v43"/><ellipse cx="80" cy="58" rx="33" ry="8"/>',
  'ripple-ring': [52, 38, 23].map(rx => `<ellipse cx="80" cy="39" rx="${rx}" ry="${rx * .32}"/>`).join(''),
  'alarm-zone': '<ellipse cx="80" cy="39" rx="54" ry="22" stroke-width="5" stroke-dasharray="10 5"/><path d="m80 24 14 22H66Z"/><path d="M80 31v7m0 3v2"/>',
  'alarm-label': '<rect x="37" y="8" width="98" height="53" rx="5" fill="#62171c88"/><path d="M45 61 29 70l8-24M49 22h70m-70 12h43m-43 12h57"/>',
  'smoke-plume': '<path d="M69 59c-28-13-23-30-5-30-12-23 25-28 25-10 27-7 33 23 9 28 14 19-26 23-29 12" fill="#abb2be66" stroke="#c8d0da"/>',
  'alarm-route': '<path d="M19 59 55 42 85 46 124 19" stroke="#24dfff"/><path d="m35 40 16 5-6 13m25-27 14 13-13 7m23-30 19 3-6 15" stroke="#24dfff" stroke-width="4"/><path d="m130 5 12 20h-24Z"/>',
};

/** 固定SVG预览用于库中识别报警类型，不依赖模型截图或外部纹理。 */
export function getAlarmEffectThumbnail(kind: string): string | undefined {
  const shape = shapes[kind];
  if (!shape) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><defs><filter id="g"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="160" height="80" rx="7" fill="#07131f"/><g fill="none" stroke="#ff3434" stroke-width="2"><g filter="url(#g)">${shape}</g>${shape}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
