import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  APP_UPDATE_UNSUPPORTED_MESSAGE,
  formatAppUpdateErrorMessage,
  formatUpdateBytes,
  normalizeReleaseNotes,
  shouldAutoOpenUpdateDialog,
  type AppUpdateState,
} from '../../electron/shared/appUpdate.ts';
import {
  createAppUpdateController,
  type AutoUpdaterLike,
} from '../../electron/shared/appUpdateController.ts';

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = [];
  onCheck: () => Promise<void> = async () => undefined;
  onDownload: () => Promise<void> = async () => undefined;

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    await this.onCheck();
    return null;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    await this.onDownload();
    return null;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push({ isSilent, isForceRunAfter });
  }
}

test('normalizeReleaseNotes cleans HTML strings and structured arrays', () => {
  assert.equal(normalizeReleaseNotes('<p>修复 <b>AGV</b> 路径问题</p><ul><li>支持自动更新</li></ul>'), '修复 AGV 路径问题\n- 支持自动更新');
  assert.equal(
    normalizeReleaseNotes([
      { version: '0.4.23', note: '<p>新增自动更新</p>' },
      { version: 'v0.4.22', note: '修复特效取数' },
    ]),
    'v0.4.23\n新增自动更新\n\nv0.4.22\n修复特效取数',
  );
  assert.equal(normalizeReleaseNotes('   '), null);
  assert.equal(normalizeReleaseNotes(null), null);
});

test('formatAppUpdateErrorMessage translates common GitHub network and manifest errors', () => {
  assert.match(formatAppUpdateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED')), /网络连接/);
  assert.match(formatAppUpdateErrorMessage(new Error('ETIMEDOUT while fetching')), /超时/);
  assert.match(formatAppUpdateErrorMessage(new Error('Cannot find latest.yml in the latest release artifacts')), /latest\.yml/);
  assert.match(formatAppUpdateErrorMessage(new Error('sha512 checksum mismatch')), /完整性校验/);
});

test('formatUpdateBytes formats sizes cleanly', () => {
  assert.equal(formatUpdateBytes(0), '0 B');
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(1536), '1.5 KB');
  assert.equal(formatUpdateBytes(120 * 1024 * 1024), '120 MB');
});

test('controller reports unsupported in unpackaged dev mode without touching updater', async () => {
  let updaterRequested = false;
  const snapshots: AppUpdateState[] = [];
  const controller = createAppUpdateController({
    isPackaged: false,
    currentVersion: '0.4.22',
    getUpdater: () => {
      updaterRequested = true;
      return new FakeAutoUpdater();
    },
    broadcast: (state) => snapshots.push(state),
    approveWindowClose: () => undefined,
    now: () => '2026-11-24T00:00:00.000Z',
  });

  assert.equal(controller.getState().stage, 'unsupported');
  const checked = await controller.checkForUpdates({ manual: true });
  assert.equal(checked.stage, 'unsupported');
  assert.equal(checked.errorMessage, APP_UPDATE_UNSUPPORTED_MESSAGE);
  assert.equal(updaterRequested, false);
  assert.equal(await controller.quitAndInstall(), false);
  assert.ok(snapshots.length >= 1);
});

test('controller transitions through check, download progress, downloaded, and approved quitAndInstall', async () => {
  const updater = new FakeAutoUpdater();
  const snapshots: AppUpdateState[] = [];
  let closeApproved = 0;

  updater.onCheck = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', {
      version: '0.4.23',
      releaseName: 'v0.4.23',
      releaseDate: '2026-11-24T08:00:00.000Z',
      releaseNotes: '<p>支持 GitHub 自动更新</p>',
    });
  };
  updater.onDownload = async () => {
    updater.emit('download-progress', {
      percent: 42.5,
      transferred: 42_500_000,
      total: 100_000_000,
      bytesPerSecond: 5_000_000,
    });
    updater.emit('update-downloaded', { version: '0.4.23' });
  };

  const controller = createAppUpdateController({
    isPackaged: true,
    currentVersion: '0.4.22',
    getUpdater: () => updater,
    broadcast: (state) => snapshots.push(state),
    approveWindowClose: () => { closeApproved += 1; },
    now: () => '2026-11-24T08:05:00.000Z',
  });

  const available = await controller.checkForUpdates({ manual: false });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(available.stage, 'available');
  assert.equal(available.availableVersion, '0.4.23');
  assert.equal(available.releaseNotes, '支持 GitHub 自动更新');
  assert.equal(shouldAutoOpenUpdateDialog(available), true);

  const downloaded = await controller.downloadUpdate();
  assert.equal(downloaded.stage, 'downloaded');
  assert.equal(downloaded.progress?.percent, 100);
  assert.equal(shouldAutoOpenUpdateDialog(downloaded), true);
  assert.ok(snapshots.some((item) => item.stage === 'downloading' && item.progress?.percent === 42.5));

  const installed = await controller.quitAndInstall();
  assert.equal(installed, true);
  assert.equal(closeApproved, 1);
  assert.deepEqual(updater.installCalls, [{ isSilent: false, isForceRunAfter: true }]);
});

test('silent no-update and error states do not auto-open update dialog', async () => {
  const updater = new FakeAutoUpdater();
  updater.onCheck = async () => {
    updater.emit('update-not-available', { version: '0.4.22' });
  };

  const controller = createAppUpdateController({
    isPackaged: true,
    currentVersion: '0.4.22',
    getUpdater: () => updater,
    broadcast: () => undefined,
    approveWindowClose: () => undefined,
  });

  const upToDate = await controller.checkForUpdates({ manual: false });
  assert.equal(upToDate.stage, 'not-available');
  assert.equal(shouldAutoOpenUpdateDialog(upToDate), false);

  updater.onCheck = async () => {
    throw new Error('ETIMEDOUT');
  };
  const errored = await controller.checkForUpdates({ manual: false });
  assert.equal(errored.stage, 'error');
  assert.equal(shouldAutoOpenUpdateDialog(errored), false);
});
