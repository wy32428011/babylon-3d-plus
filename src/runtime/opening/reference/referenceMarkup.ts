import { REFERENCE_STAGES as STAGES } from './referenceStages';
const ICONS={
 play:'<path d="m6 3 11 7-11 7z"/>',pause:'<path d="M6 3v14M14 3v14"/>',
 restart:'<path d="M4 6a7 7 0 1 1-1 7M4 2v5h5"/>',
 full:'<path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/>',
 eye:'<path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z"/><circle cx="10" cy="10" r="2.5"/>',
 close:'<path d="m5 5 10 10M15 5 5 15"/>'
};
const icon=(name:keyof typeof ICONS)=>`<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`;

export { icon as referenceIcon };
export const REFERENCE_MARKUP=`
 <canvas class="zd-canvas zd-backdrop" data-role="backdrop" aria-hidden="true"></canvas>
 <canvas class="zd-canvas zd-globe" data-role="globe" aria-hidden="true"></canvas>
 <canvas class="zd-canvas zd-effects" data-role="effects" aria-hidden="true"></canvas>
 <div class="zd-vignette"></div>
 <header class="zd-header">
  <div class="zd-brand"><svg class="zd-symbol" viewBox="0 0 36 40" fill="none" aria-hidden="true"><path d="m18 2 15 8.5v18L18 38 3 29V11z" stroke="currentColor" stroke-width="1.1"/><path d="m18 8 9 5.5v12L18 31l-9-5.5v-12zM9 13.5l9 6 9-6M18 19.5V31" stroke="currentColor" stroke-width="1.5"/><path d="M18 2v6M3 29l6-3.5M33 29l-6-3.5" stroke="currentColor" opacity=".4"/></svg>
   <div class="zd-brand-name"><span data-role="brand-name"></span><span class="zd-brand-en">INTELLIGENT WAREHOUSING · DIGITAL TWIN</span></div></div>
  <div class="zd-header-right"><div class="zd-preview-badge"><span class="zd-indicator"></span>OPENING EXPERIENCE<br><b data-role="stage-counter">01 / 09</b></div><button class="zd-icon-btn" data-action="fullscreen" title="全屏 / 退出全屏（F）" aria-label="切换全屏">${icon('full')}</button></div>
 </header>
 <section class="zd-heading"><div class="zd-overline" data-role="stage-en"></div><h2 data-role="stage-title"></h2><p data-role="stage-detail"></p><div class="zd-heading-rule"></div></section>
 <section class="zd-hero" data-role="hero"><div class="zd-overline">A JOURNEY FROM GLOBAL TO LOCAL</div><h1 data-role="hero-title"></h1><p data-role="hero-subtitle"></p><div class="zd-hero-route"><strong>地球</strong> &nbsp; → &nbsp; 中国 &nbsp; → &nbsp; 江苏<br>无锡 &nbsp; → &nbsp; 惠山 &nbsp; → &nbsp; 智能仓储</div></section>
 <aside class="zd-readout" data-role="readout"><div class="zd-readout-line" data-role="readout-line">SPATIAL SEQUENCE<br>GLOBAL → LOCAL</div><div class="zd-readout-value" data-role="readout-value">多尺度场景导航</div></aside>
 <div class="zd-bottom-location"><span>LOCATION / </span><b data-role="location">地球</b><br><span data-role="target-label">TARGET · INTELLIGENT WAREHOUSING</span></div>
 <footer class="zd-player">
  <nav class="zd-stage-list" aria-label="动画章节">${STAGES.map((s,i)=>`<button class="zd-stage-btn" data-stage="${i}" title="跳转到${s.label}"><small>${String(i+1).padStart(2,'0')}</small>${s.label}</button>`).join('')}</nav>
  <input class="zd-range" data-role="progress" type="range" min="0" max="62" value="0" step="0.01" aria-label="动画播放进度">
  <div class="zd-controls"><div class="zd-controls-left"><button class="zd-icon-btn" data-action="play" title="播放 / 暂停（空格）" aria-label="暂停">${icon('pause')}</button><button class="zd-icon-btn" data-action="restart" title="重新播放（R）" aria-label="重新播放">${icon('restart')}</button><div class="zd-time"><span data-role="time">00:00</span><i>/</i><span data-role="total-time">01:02</span></div></div>
   <div class="zd-caption-note">示意底图 · 路线非真实业务数据</div>
   <div class="zd-controls-right"><button class="zd-plain-btn" data-action="skip">跳过开场 ↗</button><button class="zd-enter" data-action="enter">进入数字孪生 <span>↗</span></button></div>
  </div>
 </footer>
 
 <div class="zd-loader" data-role="loader"><div><div class="zd-loader-orbit"></div><div class="zd-loader-title">正在构建全域视野</div><div class="zd-loader-status" data-role="load-status">加载本地场景资源</div><div class="zd-loader-progress"><i data-role="load-progress"></i></div></div></div>
 <div class="zd-toast" data-role="toast" role="status" aria-live="polite"></div>
 <button class="zd-floating-skip" data-action="skip">跳过开场 ↗</button>
`;
