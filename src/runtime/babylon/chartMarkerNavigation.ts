/** 在用户点击调用栈内创建窗口，避免异步操作丢失浏览器用户激活。 */
export function openChartMarkerSceneInNewWindow(url: string): boolean {
  let opened: Window | null = null;
  try {
    if (window.editorApi) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    opened = window.open('', '_blank');
    if (!opened) return false;
    opened.opener = null;
    opened.location.replace(url);
    return true;
  } catch {
    opened?.close();
    return false;
  }
}
