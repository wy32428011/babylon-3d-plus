/** 在原 DOM 位置展开源页面，避免移动 iframe 导致实时大屏重载。 */
export function createChartMarkerRingDialog(container: HTMLDivElement, host: HTMLDivElement) {
  let open = false;
  let previousFocus: HTMLElement | null = null;
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:absolute;left:5%;right:5%;top:12px;height:36px;display:none;align-items:center;justify-content:space-between;color:white;font:14px Microsoft YaHei,sans-serif';
  const title = document.createElement('span');
  title.textContent = '原始内容 · 关闭后返回环形屏';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.setAttribute('aria-label', '关闭环形屏原始内容');
  close.style.cssText = 'padding:6px 18px;border:1px solid #58b9dc;border-radius:4px;background:#101827;color:white;cursor:pointer';
  toolbar.append(title, close);
  container.append(toolbar);
  function hide(): void {
    if (!open) return;
    open = false;
    toolbar.style.display = 'none';
    container.style.background = 'transparent';
    container.style.pointerEvents = 'none';
    container.removeAttribute('role');
    container.removeAttribute('aria-modal');
    host.style.left = '-100000px';
    host.style.top = '0';
    host.style.transform = 'none';
    previousFocus?.focus();
  }
  function onKey(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') { event.stopPropagation(); hide(); }
  }
  close.addEventListener('click', hide);
  window.addEventListener('keydown', onKey, true);
  return {
    get isOpen() { return open; },
    hide,
    show(): void {
      if (open) return;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      open = true;
      container.style.pointerEvents = 'auto';
      container.style.background = '#050d19f5';
      container.setAttribute('role', 'dialog');
      container.setAttribute('aria-modal', 'true');
      container.setAttribute('aria-label', '环形屏原始内容');
      toolbar.style.display = 'flex';
      close.focus();
    },
    update(width: number, height: number): void {
      host.style.display = 'block';
      if (!open) {
        host.style.left = '-100000px';
        host.style.top = '0';
        host.style.transform = 'none';
        return;
      }
      const available = container.getBoundingClientRect();
      const scale = Math.min(available.width * 0.9 / width, Math.max(1, available.height - 72) / height);
      host.style.left = `${(available.width - width * scale) / 2}px`;
      host.style.top = `${56 + Math.max(0, available.height - 72 - height * scale) / 2}px`;
      host.style.transform = `scale(${scale})`;
    },
    dispose(): void {
      hide();
      window.removeEventListener('keydown', onKey, true);
      close.removeEventListener('click', hide);
      toolbar.remove();
    },
  };
}
