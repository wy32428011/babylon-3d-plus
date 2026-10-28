import { useEffect, useRef, useSyncExternalStore } from 'react';
import { decideSceneLeave, getSceneLeaveRequest, subscribeSceneLeaveRequest } from '../project/sceneLeaveDecision';
import './UnsavedSceneDialog.css';

export function UnsavedSceneDialog() {
  const current = useSyncExternalStore(subscribeSceneLeaveRequest, getSceneLeaveRequest);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!current || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, [current]);
  if (!current) return null;
  return <dialog ref={dialogRef} className="unsaved-scene-dialog" role="dialog" aria-modal="true"
    aria-labelledby="unsaved-scene-title" onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); decideSceneLeave('cancel'); }}>
    <h2 id="unsaved-scene-title">场景有未保存修改</h2>
    <p>{current.action}前，是否保存当前场景？保存失败或取消保存时将保留当前场景。</p>
    <div className="unsaved-scene-actions">
      <button type="button" onClick={() => decideSceneLeave('save')}>保存并继续</button>
      <button type="button" onClick={() => decideSceneLeave('discard')}>放弃修改</button>
      <button ref={cancelRef} type="button" onClick={() => decideSceneLeave('cancel')}>取消</button>
    </div>
  </dialog>;
}
