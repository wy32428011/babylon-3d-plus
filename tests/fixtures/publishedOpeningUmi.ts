export const history = {
  location: { state: null },
  push: (url: string) => { location.href = url; },
  replace: (url: string) => { location.replace(url); },
};
export const useParams = () => ({ id: '1' });
export const useLocation = () => ({ pathname: location.pathname, search: location.search });

/** 保留真实 service 的 HTTP 路径、数据及响应解析；本地服务器仅提供验收配置。 */
export async function request(url: string, options: Record<string, any> = {}) {
  const target = new URL(url, location.origin);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }
  target.searchParams.set('fixture', new URLSearchParams(location.search).get('fixture') || 'enabled');
  const response = await fetch(target, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
  if (!response.ok) throw new Error(`本地验收接口失败：${response.status} ${target.pathname}`);
  return response.json();
}
