/**
 * Windows installer for CKH ONE POS (electron-builder).
 *
 * Signed release build, on Windows PowerShell with the code-signing certificate:
 *   $env:NEXT_PUBLIC_API_URL = "https://api.example.com/api/v1"
 *   pnpm --filter @ckh/web build
 *   $env:CSC_LINK = "C:\certs\ckh-codesign.pfx"; $env:CSC_KEY_PASSWORD = "<password>"
 *   $env:CKH_PUBLISHER_NAME = "Your Company Co., Ltd."     # the certificate's subject (CN)
 *   $env:CKH_UPDATE_URL = "https://downloads.example.com/pos/"
 *   pnpm --filter @ckh/desktop dist:win
 *
 * Without CSC_LINK the installer is unsigned: Windows SmartScreen warns, and
 * installed copies cannot verify updates. Do not ship unsigned builds.
 * The API address is baked in from NEXT_PUBLIC_API_URL; one computer can be
 * pointed elsewhere in %APPDATA%\CKH ONE POS\config.json ("apiUrl").
 */
const signing = !!(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
const publisher = process.env.CKH_PUBLISHER_NAME;
if (signing && !publisher) throw new Error('Set CKH_PUBLISHER_NAME to the code-signing certificate subject name');

module.exports = {
  appId: 'one.ckh.pos',
  productName: 'CKH ONE POS',
  copyright: 'Copyright © CKH ONE',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*.js', 'package.json'],
  extraResources: [{ from: 'build/web', to: 'web' }],
  asar: true,
  // A plain package name for the executable and the updater's cache folder.
  extraMetadata: { name: 'ckh-one-pos' },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'CKH-ONE-POS-Setup-${version}.${ext}',
    // electron-updater refuses an update not signed by this publisher.
    ...(publisher ? { signtoolOptions: { publisherName: publisher } } : {}),
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    shortcutName: 'CKH ONE POS',
    deleteAppDataOnUninstall: false,
  },
  // Updates only when an https update server is configured for this build.
  ...(process.env.CKH_UPDATE_URL && /^https:\/\//.test(process.env.CKH_UPDATE_URL)
    ? { publish: [{ provider: 'generic', url: process.env.CKH_UPDATE_URL }] }
    : { publish: null }),
};
