export async function adaptWindow(win, app) {
  await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
  if (app && (process.platform === 'win32' || /cursor/i.test(process.env.VSCODE_BIN || ""))) {
    const sizeWindow = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (w) w.setSize(1400, 1000);
    });
    try {
      await sizeWindow();
    } catch (error) {
      if (!/Execution context was destroyed/i.test(String(error.message || error))) throw error;
      await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
      await sizeWindow();
    }
  }
  const welcome = win.locator('.antigravity-ide-welcome-button');
  if (await welcome.isVisible()) {
    await welcome.click();
    await win.waitForTimeout(1500);
  }
  const press = win.keyboard.press.bind(win.keyboard);
  win.keyboard.press = (key, options) => {
    if (process.platform === 'darwin') {
      if (/^Control\+y$/i.test(key)) key = 'Meta+Shift+z';
      key = key.replace('Control+Shift+BracketLeft', 'Meta+Alt+BracketLeft')
        .replace('Control+Shift+BracketRight', 'Meta+Alt+BracketRight')
        .replace('Control+Home', 'Meta+ArrowUp').replace('Control+End', 'Meta+ArrowDown')
        .replace(/^Control\+/, 'Meta+');
      if (key === 'End') key = 'Meta+ArrowRight';
      if (key === 'Home') key = 'Meta+ArrowLeft';
    }
    return press(key, options);
  };
  return win;
}
