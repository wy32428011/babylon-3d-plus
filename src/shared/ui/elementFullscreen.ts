type FullscreenCapableDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** 读取当前页面的 Document；Node 测试或不在浏览器时返回 null。 */
function getFullscreenDocument(): FullscreenCapableDocument | null {
  const doc = (globalThis as { document?: FullscreenCapableDocument }).document;
  return doc ?? null;
}

/** 返回当前处于系统全屏的元素；标准 API 不可用时回退 webkit 前缀。 */
export function getFullscreenElement(): Element | null {
  const doc = getFullscreenDocument();
  if (!doc) return null;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** 判断指定元素是否就是当前系统全屏目标。 */
export function isElementFullscreen(element: Element | null | undefined): boolean {
  return Boolean(element) && getFullscreenElement() === element;
}

/** 请求元素进入系统全屏；优先标准 Fullscreen API，其次 webkit 前缀。 */
export async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const target = element as FullscreenCapableElement;
  if (typeof target.requestFullscreen === 'function') {
    await target.requestFullscreen.call(target);
    return;
  }
  if (typeof target.webkitRequestFullscreen === 'function') {
    await target.webkitRequestFullscreen.call(target);
    return;
  }
  throw new Error('当前环境不支持系统全屏。');
}

/** 判断当前系统全屏目标是否属于指定元素（自身或其子孙）。 */
export function isOwnedFullscreenElement(element: Element | null | undefined): boolean {
  const current = getFullscreenElement();
  if (!element || !current) return false;
  if (current === element) return true;
  return typeof element.contains === 'function' && element.contains(current);
}

/** 仅当当前全屏目标属于指定元素时退出；不传元素则退出任意全屏。 */
export async function exitElementFullscreen(element?: Element | null): Promise<void> {
  const doc = getFullscreenDocument();
  if (!doc || !getFullscreenElement()) return;
  if (element && !isOwnedFullscreenElement(element)) return;
  if (typeof doc.exitFullscreen === 'function') {
    await doc.exitFullscreen.call(doc);
    return;
  }
  if (typeof doc.webkitExitFullscreen === 'function') {
    await doc.webkitExitFullscreen.call(doc);
    return;
  }
  throw new Error('当前环境不支持退出系统全屏。');
}

/** 订阅标准与 webkit 全屏状态变化，返回取消订阅函数。 */
export function subscribeFullscreenChange(listener: () => void): () => void {
  const doc = getFullscreenDocument();
  if (!doc) return () => undefined;
  doc.addEventListener('fullscreenchange', listener);
  doc.addEventListener('webkitfullscreenchange', listener);
  return () => {
    doc.removeEventListener('fullscreenchange', listener);
    doc.removeEventListener('webkitfullscreenchange', listener);
  };
}
