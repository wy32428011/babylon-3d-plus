import conveyor from './conveyor.model.txt?raw';
import shelf from './shelf.model.txt?raw';
import shuttle from './shuttle.model.txt?raw';
import type { AuthoringProject, BinaryAsset } from '../types';

export type TrustedTemplateId = 'conveyor' | 'shelf' | 'shuttle';

// 摘要绑定原文件字节，不能通过模型名称、包内声明或工程 JSON 提升脚本信任。
const templates = {
  conveyor: { text: conveyor, sha256: 'c5edfc8300dd6eca04bed9f468e6e4e3825474b64244d291df82a3e1cd2f19b0' },
  shelf: { text: shelf, sha256: '0c7fdf3f14913e1b5a812fcc23e602c35ca03e1ef767f9ec7b83fbd963fff087' },
  shuttle: { text: shuttle, sha256: '5eabfb71c91abb67c5ef18564efac3ebeba9dd245e48cfa9b5dda5541546c8fe' },
} as const;

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export async function identifyTrustedTemplate(bytes: Uint8Array): Promise<TrustedTemplateId | undefined> {
  const digest = await sha256(bytes);
  return (Object.keys(templates) as TrustedTemplateId[]).find(id => templates[id].sha256 === digest);
}

/** 每次执行或生成都重新认证实际资产，不能只相信导入时缓存的 templateId。 */
export async function trustedTemplate(project: AuthoringProject, assets: Map<string, BinaryAsset>): Promise<string | null> {
  if (!project.legacy.enabled) return null;
  const scripts = project.source?.scripts;
  if (!scripts || scripts.length !== 1) throw new Error('模板模式只允许一份已认证的完整运行脚本。');
  const asset = assets.get(scripts[0].assetId);
  if (!asset) throw new Error('可信模板原脚本资产丢失。');
  const id = await identifyTrustedTemplate(asset.bytes);
  if (!id || id !== project.legacy.templateId) throw new Error('模板脚本摘要不匹配，禁止执行旧脚本。');
  // Vite raw 文本可能规范化 BOM；认证基于原资产，执行固定的内置源码。
  return templates[id].text;
}
