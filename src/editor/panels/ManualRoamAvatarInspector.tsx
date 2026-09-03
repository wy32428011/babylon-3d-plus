import { useEffect, useRef, useState } from 'react';
import type { ProjectModelAssetEntry } from '../assets/AssetDatabase';
import type { ManualRoamSpawnComponent } from '../model/components';
import { useEditorStore } from '../store/editorStore';

export function ManualRoamAvatarInspector(props: {
  entityId: string;
  component: ManualRoamSpawnComponent;
  disabled: boolean;
}) {
  const [assets, setAssets] = useState<ProjectModelAssetEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const avatar = props.component.avatar;
  const setAvatar = useEditorStore((state) => state.setManualRoamAvatar);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void window.editorApi?.listProjectAssets().then((result) => {
      if (active) setAssets(result.assets);
    }).catch((reason: unknown) => {
      if (active) setError(`读取人物模型列表失败：${String(reason)}`);
    });
    return () => { active = false; mounted.current = false; };
  }, []);

  async function upload(): Promise<void> {
    if (!window.editorApi || busy) return;
    const sessionId = useEditorStore.getState().sceneSessionId;
    setBusy(true);
    setError(null);
    try {
      const result = await window.editorApi.importManualRoamAvatar();
      if (!mounted.current || sessionId !== useEditorStore.getState().sceneSessionId) return;
      if (result.canceled || !result.importedAsset) return;
      const asset = result.importedAsset;
      setAssets((previous) => [...previous.filter((item) => item.path !== asset.path), asset]);
      setAvatar(props.entityId, {
        name: asset.displayName || asset.name, sourcePath: asset.path,
        sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
      });
    } catch (reason) {
      if (mounted.current) setError(`上传人物失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const candidates = assets.filter((asset) => asset.libraryKind === 'model' && /\.glb$/i.test(asset.path));
  return (
    <fieldset className="transform-fieldset" disabled={props.disabled || busy}>
      <legend>漫游人物模型</legend>
      <label className="inspector-row">
        <span>人物</span>
        <select aria-label="漫游人物模型" value={avatar?.sourceUrl ?? ''} onChange={(event) => {
          setError(null);
          const asset = candidates.find((item) => item.sourceUrl === event.target.value);
          if (!event.target.value) setAvatar(props.entityId, null);
          else if (asset) setAvatar(props.entityId, {
            name: asset.displayName || asset.name, sourcePath: asset.path,
            sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
          });
        }}>
          <option value="">默认人物</option>
          {avatar && !candidates.some((asset) => asset.sourceUrl === avatar.sourceUrl)
            ? <option value={avatar.sourceUrl}>{avatar.name}</option> : null}
          {candidates.map((asset) => <option key={asset.path} value={asset.sourceUrl}>{asset.displayName || asset.name}</option>)}
        </select>
      </label>
      <button type="button" disabled={!window.editorApi} onClick={() => void upload()}>
        {busy ? '正在上传…' : '上传人物模型（GLB）'}
      </button>
      <p className="muted">使用内嵌纹理的单文件 GLB，自动适配人物身高。自带动画可用于行走；无动画模型保留原始姿态。</p>
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  );
}
