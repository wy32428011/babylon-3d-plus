import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSceneLightingBakeError } from '../../../electron/shared/sceneLightingBakeContract';
import type { LightingBakeEngineConfiguration } from '../../../electron/shared/lightingBakeEngineConfiguration';
import { LightingBakeEngineDialog } from '../panels/LightingBakeEngineDialog';

type LightingBakePublishEngineCheckProps = {
  open: boolean;
  scene: unknown;
  error?: string | null;
  disabled?: boolean;
  onDialogOpenChange?: (open: boolean) => void;
};

/** 已有有效结果的发布不依赖 Blender；异步同步或其他场景的引擎失败仍提供恢复入口。 */
export function getLightingBakePublishRequirement(scene: unknown, error?: string | null): string | null {
  const requirement = getSceneLightingBakeError(scene);
  if (requirement) return requirement;
  return error && /Blender|lighting-bake(?::|[- ]engine)|烘焙引擎/i.test(error) ? error : null;
}

/** 发布前展示本机引擎状态；配置与重新检测都保留外层表单，实际发布仍执行原有完整校验。 */
export function LightingBakePublishEngineCheck({ open, scene, error, disabled = false, onDialogOpenChange }: LightingBakePublishEngineCheckProps) {
  const requirement = useMemo(() => getLightingBakePublishRequirement(scene, error), [scene, error]);
  const needsEngine = requirement !== null;
  const [configuration, setConfiguration] = useState<LightingBakeEngineConfiguration | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setChecking(true);
    setCheckError(null);
    try {
      if (!window.editorApi?.getLightingBakeEngineConfiguration) throw new Error('检测本机烘焙引擎需要 Electron 桌面编辑器。');
      const next = await window.editorApi.getLightingBakeEngineConfiguration();
      if (requestId === requestRef.current) setConfiguration(next);
    } catch (reason) {
      if (requestId === requestRef.current) {
        setConfiguration(null);
        setCheckError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === requestRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (open && needsEngine) void refresh();
    return () => { requestRef.current += 1; };
  }, [open, needsEngine, error, refresh]);

  useEffect(() => {
    if (!open || !needsEngine) setDialogOpen(false);
  }, [open, needsEngine]);

  useEffect(() => {
    onDialogOpenChange?.(dialogOpen);
    return () => onDialogOpenChange?.(false);
  }, [dialogOpen, onDialogOpenChange]);

  if (!open || !needsEngine) return null;

  /** 保存只刷新引擎快照，不触发远端发布或重置外层的输入、确认项与失败记录。 */
  function handleSaved(next: LightingBakeEngineConfiguration): void {
    requestRef.current += 1;
    setConfiguration(next);
    setChecking(false);
    setCheckError(null);
    setDialogOpen(false);
  }

  const engine = configuration?.engine;
  const status = checking ? '正在检查本机烘焙引擎…'
    : engine?.available ? '本机烘焙引擎已就绪，可继续发布。'
      : '发布前需要生成或刷新光照，请先配置可用的 Blender 4+。';

  return <>
    <section className="deployment-export-dialog-section" aria-label="发布检查">
      <div className="deployment-export-section-heading">
        <h3>发布检查</h3>
        <span>{checking ? '正在检测' : engine?.available ? '引擎就绪' : '需要配置'}</span>
      </div>
      <p aria-live="polite" role="status">{status}</p>
      {!engine?.available && !checking ? <p className="digital-twin-publish-message">{requirement}</p> : null}
      {engine?.available && !checking ? <p className="deployment-export-resource-detail">Blender {engine.version ?? ''}{engine.path ? ` · ${engine.path}` : ''}</p> : null}
      {!checking && (checkError || configuration?.configurationError || (!engine?.available && engine?.message)) ? (
        <p className="deployment-export-error" role="alert">{checkError ?? configuration?.configurationError ?? engine?.message}</p>
      ) : null}
      <div className="deployment-export-dialog-actions">
        <button disabled={disabled || checking || configuration?.busy} onClick={() => setDialogOpen(true)} type="button">配置 Blender…</button>
        <button disabled={disabled || checking} onClick={() => void refresh()} type="button">重新检查引擎</button>
      </div>
    </section>
    <LightingBakeEngineDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={handleSaved} disabled={disabled} />
  </>;
}
