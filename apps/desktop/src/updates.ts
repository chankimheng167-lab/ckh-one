import { app, dialog } from 'electron';

/**
 * Checks for a new version when the app was installed from a signed build.
 * electron-updater downloads from the update URL baked into the installer
 * (CKH_UPDATE_URL at build time), checks the file's SHA-512 against
 * latest.yml, and on Windows refuses an update not signed by the same
 * publisher as the installed app. Nothing is installed until the cashier
 * agrees, so a sale is never interrupted.
 */
export async function checkForUpdates(log: (m: string) => void) {
  if (!app.isPackaged || process.env.CKH_DISABLE_UPDATES === '1') return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('error', (e) => log(`update error: ${e.message}`));
    autoUpdater.on('update-downloaded', async (info) => {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        message: `CKH ONE POS ${info.version} is ready to install`,
        detail: 'Finish the current sale first. The update installs when the app restarts.',
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    });
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log(`update check failed: ${(e as Error).message}`);
  }
}
