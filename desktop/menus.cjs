'use strict';
const { productName } = require('./package.json');
const { webUrl } = require('./security.cjs');
function createMenus({
  getConnection,
  getWindow,
  machine,
  Menu,
  dialog,
  shell,
  reconnect,
  showSetup,
  t,
  getLanguage,
  setLanguage,
}) {
  let noticeAt = 0,
    noticeOpen = false,
    shortcutsOpen = false;
  async function showShortcuts() {
    const window = getWindow();
    if (!window || window.isDestroyed() || !window.isVisible() || shortcutsOpen) return;
    const modifier = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
    const shift = process.platform === 'darwin' ? '⇧' : 'Shift+';
    const shortcut = (keys, label) => `${modifier}${keys}    ${t(label)}`;
    const section = (label, lines) => [t(label), ...lines].join('\n');
    const groups = [];
    if (getConnection()?.attached)
      groups.push(
        section('workspace', [
          shortcut('K', 'searchConversations'),
          shortcut(`${shift}N`, 'newGroupChat'),
          shortcut(',', 'openSettings'),
          `Enter    ${t('sendInComposer')}`,
          `Shift+Enter    ${t('newLineInComposer')}`,
          shortcut('D', 'dictateInComposer'),
        ]),
      );
    groups.push(
      section('window', [
        shortcut('/', 'keyboardShortcuts'),
        shortcut('R', 'reconnect'),
        shortcut(`${shift}O`, 'switchWorkspace'),
        `${['+', '-', '0'].map((key) => modifier + key).join(' / ')}    ${t('changeZoom')}`,
      ]),
    );
    shortcutsOpen = true;
    try {
      await dialog.showMessageBox(window, {
        type: 'info',
        title: productName,
        message: t('keyboardShortcuts'),
        detail: groups.join('\n\n'),
        buttons: [t('gotIt')],
      });
    } catch {
      // The window can close while a native dialog is opening.
    } finally {
      shortcutsOpen = false;
    }
  }
  function explainBlocked() {
    if (noticeOpen || Date.now() - noticeAt < 10_000 || !getWindow() || getWindow().isDestroyed())
      return;
    noticeAt = Date.now();
    noticeOpen = true;
    void dialog
      .showMessageBox(getWindow(), {
        type: 'info',
        title: t('external'),
        message: t('linkBlocked'),
        detail: t('linkHelp'),
        buttons: [t('gotIt')],
      })
      .finally(() => {
        noticeOpen = false;
      });
  }
  async function openExternalFromMenu(value, current) {
    const url = webUrl(value);
    if (!url || getConnection() !== current || !getWindow() || getWindow().isDestroyed()) return;
    const result = await dialog.showMessageBox(getWindow(), {
      type: 'question',
      title: t('openLink'),
      message: t('openOrigin', { origin: url.origin }),
      detail: url.href,
      buttons: [t('cancel'), t('openBrowser')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1 || getConnection() !== current) return;
    // This is reachable only from a native context-menu click, never renderer IPC or navigation.
    await shell.openExternal(url.href).catch(() => explainBlocked());
  }
  function menuTarget() {
    if (!getWindow() || getWindow().isDestroyed()) return;
    const contents = getConnection()?.attached
      ? getConnection().view.webContents
      : getWindow().webContents;
    return contents.isDestroyed() ? undefined : contents;
  }
  function editMenuItem(action, target = menuTarget) {
    const definitions = {
      undo: [t('undo'), 'CmdOrCtrl+Z'],
      redo: [t('redo'), process.platform === 'darwin' ? 'CmdOrCtrl+Shift+Z' : 'CmdOrCtrl+Y'],
      cut: [t('cut'), 'CmdOrCtrl+X'],
      copy: [t('copy'), 'CmdOrCtrl+C'],
      paste: [t('paste'), 'CmdOrCtrl+V'],
      selectAll: [t('selectAll'), 'CmdOrCtrl+A'],
    };
    const [label, accelerator] = definitions[action];
    return {
      label,
      accelerator,
      click: () => {
        const contents = target();
        if (!contents || contents.isDestroyed()) return;
        if (process.platform === 'darwin') {
          // Let AppKit route both page editing and native save/open fields.
          // Electron's focus flags do not reliably identify a native sheet.
          Menu.sendActionToFirstResponder(`${action}:`);
          return;
        }
        // Menu roles target BrowserWindow's setup page, not its WebContentsView.
        contents.focus();
        contents[action]();
      },
    };
  }
  function bindContextMenu(contents, current) {
    contents.on('context-menu', (_event, params) => {
      if (getConnection() !== current || !getWindow() || getWindow().isDestroyed()) return;
      const target = () =>
        getConnection() === current && current.attached && menuTarget() === contents
          ? contents
          : undefined;
      const entries = [];
      if (params.linkURL && webUrl(params.linkURL))
        entries.push(
          {
            label: t('openLinkMenu'),
            click: () => void openExternalFromMenu(params.linkURL, current),
          },
          { type: 'separator' },
        );
      if (params.isEditable)
        entries.push(
          editMenuItem('undo', target),
          editMenuItem('redo', target),
          { type: 'separator' },
          editMenuItem('cut', target),
          editMenuItem('copy', target),
          editMenuItem('paste', target),
          editMenuItem('selectAll', target),
        );
      else if (params.selectionText)
        entries.push(editMenuItem('copy', target), editMenuItem('selectAll', target));
      if (entries.length) Menu.buildFromTemplate(entries).popup({ window: getWindow() });
    });
  }
  function installMenu() {
    const target = menuTarget;
    // Native roles keep AppKit editing available inside a modal save/open
    // panel, where the JavaScript menu callback may not be dispatched.
    const edit = (action) =>
      process.platform === 'darwin' ? { role: action, label: t(action) } : editMenuItem(action);
    const menu = [
      ...(process.platform === 'darwin'
        ? [
            {
              label: productName,
              submenu: [
                { role: 'about', label: t('about') },
                { type: 'separator' },
                { role: 'hide', label: t('hide') },
                { role: 'hideOthers', label: t('hideOthers') },
                { role: 'unhide', label: t('unhide') },
                { type: 'separator' },
                { role: 'quit', label: t('quit') },
              ],
            },
          ]
        : []),
      {
        label: t('workspace'),
        submenu: [
          {
            label: t('reconnect'),
            accelerator: 'CmdOrCtrl+R',
            enabled: Boolean(getConnection()?.managed || machine.lastAttempt),
            click: () => void reconnect(),
          },
          { label: t('switchWorkspace'), accelerator: 'CmdOrCtrl+Shift+O', click: showSetup },
          { type: 'separator' },
          {
            role: process.platform === 'darwin' ? 'close' : 'quit',
            label: t(process.platform === 'darwin' ? 'close' : 'quit'),
          },
        ],
      },
      {
        label: t('edit'),
        submenu: [
          edit('undo'),
          edit('redo'),
          { type: 'separator' },
          edit('cut'),
          edit('copy'),
          edit('paste'),
          edit('selectAll'),
        ],
      },
      {
        label: t('view'),
        submenu: [
          {
            label: t('actualSize'),
            accelerator: 'CmdOrCtrl+0',
            click: () => target()?.setZoomLevel(0),
          },
          {
            label: t('zoomIn'),
            accelerator: 'CmdOrCtrl+Plus',
            click: () => {
              const wc = target();
              if (wc) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3));
            },
          },
          {
            label: t('zoomOut'),
            accelerator: 'CmdOrCtrl+-',
            click: () => {
              const wc = target();
              if (wc) wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -2));
            },
          },
          { type: 'separator' },
          { role: 'togglefullscreen', label: t('fullScreen') },
        ],
      },
      {
        label: t('language'),
        submenu: ['zh-CN', 'en'].map((locale) => ({
          label: locale === 'zh-CN' ? '简体中文' : 'English',
          type: 'radio',
          checked: getLanguage() === locale,
          click: () => setLanguage(locale),
        })),
      },
      {
        label: t('window'),
        submenu: [
          { role: 'minimize', label: t('minimize') },
          { role: 'zoom', label: t('zoom') },
          { type: 'separator' },
          { role: 'front', label: t('front') },
        ],
      },
      {
        role: 'help',
        label: t('help'),
        submenu: [
          {
            label: t('keyboardShortcuts'),
            accelerator: 'CmdOrCtrl+/',
            click: () => void showShortcuts(),
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  }
  return { explainBlocked, menuTarget, bindContextMenu, installMenu };
}
module.exports = { createMenus };
