export { hashSha256 as hashSkyboxContent } from "../../../electron/shared/sha256.ts";

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

/** getRandomValues 可用于 HTTP；代际标识只负责并发隔离，不替代内容校验。 */
export function createSkyboxCacheGeneration(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
