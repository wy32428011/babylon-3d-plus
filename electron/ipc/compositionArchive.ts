import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CompositionLibraryEntry } from '../shared/compositionTypes.js';
import { compositionRoot, materializeComposition, readCompositionIndex, mutateCompositionIndex } from './compositionPackage.js';
import { extractCompositionArchive, zipCompositionPackage } from './compositionRemote.js';

export async function importCompositionArchive(root: string, file: string): Promise<CompositionLibraryEntry> {
  const id = randomUUID(), revision = randomUUID(), packagePath = path.resolve(compositionRoot(root), id, revision);
  await fs.mkdir(packagePath, { recursive: true });
  let committed = false;
  try {
    await extractCompositionArchive(file, packagePath);
    const raw = await fs.readFile(path.join(packagePath, 'composition.json'), 'utf8');
    const manifest = JSON.parse(raw);
    const entry: CompositionLibraryEntry = { id, revision, packagePath, name: manifest.definition.name,
      definition: manifest.definition, memberCount: manifest.definition.nodes.filter((n: {isFolder?: boolean}) => !n.isFolder).length, contentSha256: createHash('sha256').update(raw).digest('hex'), updatedAt: new Date().toISOString(), syncStatus: 'pending' };
    const result = await materializeComposition(entry);
    entry.thumbnailUrl = result.thumbnailUrl;
    await fs.writeFile(path.join(packagePath, 'entry.json'), JSON.stringify(entry), 'utf8');
    await mutateCompositionIndex(root, latest => [...latest, entry]); committed = true;
    return result;
  } finally {
    if (!committed && path.relative(compositionRoot(root), packagePath).split(path.sep).length === 2) await fs.rm(packagePath, { recursive: true, force: true });
  }
}
export async function exportCompositionArchive(root: string, id: string, target: string) {
  const entry = (await readCompositionIndex(root)).find(e => e.id === id);
  if (!entry) throw new Error('组合卡片已不存在。');
  await materializeComposition(entry);
  await zipCompositionPackage(entry, target);
}
