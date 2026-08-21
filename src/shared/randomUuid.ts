export type RandomUuidCrypto = Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>;

const UUID_BYTE_LENGTH = 16;

function createFallbackRandomUuid(cryptoApi: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(UUID_BYTE_LENGTH));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 优先使用浏览器原生实现，非安全上下文则使用 Web Crypto 随机源生成 UUID v4。 */
export function createRandomUuid(cryptoApi: RandomUuidCrypto | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('当前浏览器不支持 Web Crypto 随机数生成。');
  }
  return createFallbackRandomUuid(cryptoApi);
}

/** Viewer 启动前补齐 randomUUID，使现有运行时调用在局域网 HTTP 环境中保持兼容。 */
export function installRandomUuidFallback(
  cryptoApi: RandomUuidCrypto | undefined = globalThis.crypto,
): void {
  if (typeof cryptoApi?.randomUUID === 'function') return;
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('当前浏览器不支持 Web Crypto 随机数生成。');
  }
  Object.defineProperty(cryptoApi, 'randomUUID', {
    configurable: true,
    value: () => createFallbackRandomUuid(cryptoApi),
  });
}
