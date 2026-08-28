const HARNESS_STATE_KEY = '__task4SkyboxLifecycleHarness';

const getState = () => globalThis[HARNESS_STATE_KEY];

export const app = {
  isPackaged: false,
  getAppPath: () => getState().appPath,
  getPath: (name) => (name === 'userData' ? getState().userDataRoot : getState().appPath),
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
};

export const ipcMain = {
  handle(channel, handler) {
    getState().handlers.set(channel, handler);
  },
};

export const BrowserWindow = {
  getAllWindows: () => [],
};

export const net = {
  fetch() {
    getState().networkCalls += 1;
    throw new Error('Test harness forbids real network requests.');
  },
};
