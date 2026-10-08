// Checks that the desktop app stays offline: run with `npm run test:offline`
// (needs a display; on Linux CI use xvfb-run).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = await _electron.launch({ executablePath: electronPath, args: ['--no-sandbox', root] });
try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const switches = await app.evaluate(({ app }) => ({
    noProxy: app.commandLine.hasSwitch('no-proxy-server'),
    noBackground: app.commandLine.hasSwitch('disable-background-networking')
  }));
  assert.deepEqual(switches, { noProxy: true, noBackground: true });

  // Any request leaving the machine must be refused by the app itself
  // (ERR_BLOCKED_BY_CLIENT), before any DNS resolution.
  for (const url of ['https://example.com/', 'http://10.12.0.4/']) {
    const error = await app.evaluate(
      ({ BrowserWindow }, url) =>
        new Promise((resolve) => {
          const probe = new BrowserWindow({ show: false });
          probe.webContents.once('did-fail-load', (_e, _code, description) => resolve(description));
          probe.webContents.once('did-finish-load', () => resolve('loaded'));
          probe.loadURL(url).catch(() => {});
        }).finally(() => BrowserWindow.getAllWindows().filter((w) => !w.isVisible()).forEach((w) => w.destroy())),
      url
    );
    assert.equal(error, 'ERR_BLOCKED_BY_CLIENT', url);
  }

  // The window still loads its own local files.
  assert.equal(await win.title(), 'BPMN vers draw.io');
  console.log('OK : application hors ligne (proxy désactivé, requêtes réseau bloquées).');
} finally {
  await app.close();
}
