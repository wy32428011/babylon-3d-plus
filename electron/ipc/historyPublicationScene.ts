/** 历史发布只接受场景中的显式声明；普通场景继续走原发布路径。 */
export function readHistoryPublicationSettings(sceneContent: string): Record<string, unknown> | null {
  const document: unknown = JSON.parse(sceneContent);
  if (!object(document) || !object(document.scene) || !object(document.scene.sceneSettings)) return null;
  const raw = document.scene.sceneSettings.historyReplay;
  if (raw === undefined || raw === null) return null;
  if (!object(raw)) throw new Error('时光回溯设置无效，不能确定发布安全边界。');
  if (raw.enabled === undefined) return null;
  if (typeof raw.enabled !== 'boolean') throw new Error('时光回溯设置无效，不能确定发布安全边界。');
  return raw.enabled ? raw : null;
}

const SECRET_KEYS = new Set([
  'password', 'passwd', 'apikey', 'xapikey', 'authtoken', 'secret', 'clientsecret',
  'accesstoken', 'refreshtoken', 'authorization', 'proxyauthorization', 'credential', 'credentials',
]);

/** 与中台包核验器的 JSON 凭据规则保持一致；只报告位置类型，不泄露字段内容。 */
export function assertHistorySceneHasNoCredentials(sceneContent: string): void {
  const root: unknown = JSON.parse(sceneContent);
  const queue: unknown[] = [root];
  let count = 0;
  while (queue.length) {
    const value = queue.pop();
    if (++count > 2_000_000) throw new Error('历史场景超过凭据检查结构预算。');
    if (Array.isArray(value)) {
      if (value.length + count > 2_000_000) throw new Error('历史场景超过凭据检查结构预算。');
      for (const item of value) queue.push(item);
      continue;
    }
    if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        const normalized = key.replace(/[-_]/gu, '').toLowerCase();
        if (SECRET_KEYS.has(normalized) && child !== null && child !== ''
          && !(Array.isArray(child) && child.length === 0)
          && !(object(child) && Object.keys(child).length === 0)) {
          throw new Error('历史发布的场景仍含认证字段；请先迁移到受控服务器来源，SOURCE 和 DIST 均不得携带旧凭据。');
        }
        queue.push(child);
      }
    } else if (typeof value === 'string') {
      assertNoCredentialUrl(value);
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('历史场景包含非有限数值，不能冻结。');
    }
  }
}

function assertNoCredentialUrl(value: string): void {
  if (!/^(?:https?|wss?|tcp|ssl):\/\//iu.test(value)) return;
  const rest = value.slice(value.indexOf('://') + 3);
  const authority = rest.split(/[/?#]/u, 1)[0];
  if (authority.includes('@')) throw new Error('历史场景的连接地址包含认证信息，请先迁移到受控服务器来源。');
  const query = value.indexOf('?'), fragment = value.indexOf('#');
  if (query < 0 || (fragment >= 0 && fragment < query)) return;
  for (const part of value.slice(query + 1, fragment < 0 ? value.length : fragment).split('&')) {
    const separator = part.indexOf('=');
    let name: string;
    try { name = decodeURIComponent((separator < 0 ? part : part.slice(0, separator)).replace(/\+/gu, ' ')).replace(/[-_]/gu, '').toLowerCase(); }
    catch { throw new Error('历史场景的连接地址 Query 编码无效，无法安全检查凭据。'); }
    if (separator >= 0 && separator < part.length - 1 && (name === 'token' || SECRET_KEYS.has(name))) {
      throw new Error('历史场景的连接地址 Query 包含认证信息，请先迁移到受控服务器来源。');
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
