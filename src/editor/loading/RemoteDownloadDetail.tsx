import type { RemoteDownloadProgress } from '../../../electron/shared/remoteDownloadProgress';
import { formatRemoteDownloadProgress } from './sceneRemoteDownloadProgress';
import styles from './RemoteDownloadDetail.module.css';

export function RemoteDownloadDetail({ label, download }: {
  label: string;
  download: RemoteDownloadProgress;
}) {
  const text = formatRemoteDownloadProgress(download);
  return (
    <div className={styles.detail} data-remote-download={label}>
      <div className={styles.summary}>{label}：{text.summary}</div>
      {text.currentFile ? <div className={styles.file} title={text.currentFile}>{text.currentFile}</div> : null}
    </div>
  );
}
