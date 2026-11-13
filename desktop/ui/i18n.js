'use strict';

(function publish(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.OpenBotClientLanguage = api;
})(() => {
  const locales = Object.freeze(['zh-CN', 'en']);
  // Keep product data and addresses outside this UI-only catalog.
  const entries = {
    pageTitle: ['连接工作空间 · BambooShift', 'Connect to a workspace · BambooShift'],
    connectWorkspace: ['连接工作空间', 'Connect to workspace'],
    heading: ['连接你的工作空间', 'Connect to your workspace'],
    intro: [
      '在这台电脑创建工作空间，或连接已有的 BambooShift 服务。',
      'Create a workspace on this computer or connect to an existing BambooShift service.',
    ],
    startLocal: ['在这台电脑开始', 'Start on this computer'],
    existingWorkspace: ['连接已有工作空间', 'Connect to an existing workspace'],
    localWorkspaceNote: [
      '无需注册或登录，配置自己的模型后即可使用。对话和文件保存在这台电脑，退出应用会停止本机任务。',
      'No account or sign-in needed. Configure your own model to get started. Chats and files stay on this computer; quitting the app stops local tasks.',
    ],
    localRuntimeUnavailable: [
      '此安装包未提供可用的本地运行环境。你仍可以连接已有工作空间。',
      'This installation has no usable local runtime. You can still connect to an existing workspace.',
    ],
    localRuntimeStarting: ['正在启动本地工作空间…', 'Starting the local workspace…'],
    localRuntimeFailed: [
      '无法启动本地工作空间。请重试或连接已有工作空间。',
      'The local workspace could not start. Retry or connect to an existing workspace.',
    ],
    localRuntimeTimeout: [
      '本地工作空间启动超时，请重试。',
      'Starting the local workspace timed out. Please retry.',
    ],
    localRuntimeExited: [
      '本地工作空间已停止，可以重新启动。',
      'The local workspace has stopped. You can start it again.',
    ],
    localWorkspaceMenu: ['本机工作空间…', 'Workspace on this computer…'],
    localStatusWorkspace: ['本机个人空间正在运行', 'Your local workspace is running'],
    localStatusWorkspaceHelp: [
      '对话和工作空间文件保存在这台电脑。本次未开启整机操作，可继续聊天和处理工作空间文件。',
      'Chats and workspace files stay on this computer. Computer control is off; you can still chat and work with workspace files.',
    ],
    localStatusControl: ['本机整机操作已开启', 'Local computer control is enabled'],
    localStatusControlHelp: [
      '本次已开启整机操作，可在工作空间的电脑面板查看可用能力。',
      'Computer control is enabled for this session. Check capabilities in the workspace computer panel.',
    ],
    localStatusPermissionBoundary: [
      '录屏、键鼠仍需系统授权，电脑操作仍需审批。此窗口不会更改权限。',
      'Screen, keyboard and mouse access still require OS permission; actions follow workspace approval rules. This window changes no permissions.',
    ],
    localStatusRemote: ['已连接已有工作空间', 'Connected to an existing workspace'],
    localStatusRemoteHelp: [
      '工作由已连接的服务运行，执行电脑由该服务选择。使用桌面客户端不会自动授权操作这台电脑。',
      'Tasks use the computer connected to your existing service. This desktop client does not automatically select this computer.',
    ],
    localStatusDisconnected: ['尚未打开工作空间', 'No workspace is open'],
    localStatusDisconnectedHelp: [
      '在启动页选择“在这台电脑开始”，配置模型后即可免登录使用。需要操作本机终端或其他应用时，启动前选择“允许整机操作”。',
      'Choose “Start on this computer”, then configure a model. No sign-in is needed. Select “Allow computer control” before starting to use host commands or other apps.',
    ],
    localStatusStarting: ['工作空间正在连接或启动', 'Workspace is connecting or starting'],
    localStatusStartingHelp: [
      '连接完成后再查看本次运行方式。此窗口不会取消启动或更改执行权限。',
      'Check the active mode after the connection completes. This window does not cancel startup or change execution permissions.',
    ],
    localStatusStopWarning: [
      '返回启动页会停止本机任务，已保存的对话和文件保留。可在那里调整“允许整机操作”后重新启动。',
      'Returning to startup stops local tasks. Saved chats and files remain. Adjust “Allow computer control” there, then start again.',
    ],
    localStatusLeaveRemote: [
      '返回启动页只断开此客户端，服务端任务继续。随后可选择“在这台电脑开始”。',
      'Returning to startup disconnects this client; tasks on the existing service continue. Then choose “Start on this computer”.',
    ],
    localStatusAdjust: ['返回启动页调整', 'Return to startup to adjust'],
    hostControl: ['允许整机操作', 'Allow computer control'],
    hostControlHelp: [
      'Bot 可在你批准后操作屏幕、键鼠、文件和终端。macOS 可能要求录屏和辅助功能权限。',
      'With your approval, Bots can use the screen, keyboard, mouse, files, and terminal. macOS may ask for Screen Recording and Accessibility permissions.',
    ],
    localHostControlUnavailable: [
      '此安装包未提供整机操作。你可以使用普通本机工作空间。',
      'Computer control is unavailable in this installation. You can still use the local workspace.',
    ],
    localHostControlFailed: [
      '整机操作组件未能启动。请重试，或取消勾选后打开本机工作空间。',
      'Computer control could not start. Retry, or turn off computer control and open the local workspace.',
    ],
    cancelLocal: ['取消启动', 'Cancel startup'],
    mascot: ['BambooShift 吉祥物', 'BambooShift mascot'],
    address: ['工作空间地址', 'Workspace address'],
    addressPlaceholder: ['https://你的工作空间地址', 'https://your-workspace.example'],
    secureAddress: [
      '远程工作空间请使用 https:// 地址。',
      'Use an https:// address for a remote workspace.',
    ],
    useLocal: ['填入本机地址', 'Fill in local address'],
    unavailable: ['暂时无法连接', 'Unable to connect'],
    errorHelp: [
      '请检查地址与网络，并确认工作空间正在运行。',
      'Check the address and network, and make sure your workspace is running.',
    ],
    preparing: ['正在准备…', 'Preparing…'],
    connecting: ['正在连接…', 'Connecting…'],
    opening: ['正在打开工作空间…', 'Opening workspace…'],
    retry: ['重试连接', 'Retry connection'],
    changeAddress: ['更换工作空间地址', 'Change workspace address'],
    reading: ['正在读取连接信息…', 'Reading connection details…'],
    checking: ['正在确认工作空间是否可用…', 'Checking workspace availability…'],
    connected: ['已连接，正在打开你的工作空间。', 'Connected. Opening your workspace.'],
    returnHelp: [
      '任务在服务端运行。只要服务仍在线，关闭客户端后任务也可以继续。',
      'Tasks run on your workspace server and can continue after this app closes.',
    ],
    accountLogin: [
      '连接已有服务时，使用该服务的 BambooShift 账户登录；首次使用可在登录页注册。',
      'When connecting to an existing service, sign in with your BambooShift account for that service. New users can register on its sign-in page.',
    ],
    language: ['客户端语言', 'Client language'],
    languageHelp: [
      '仅保存于此客户端；工作空间内的语言可在其设置中选择。',
      'Saved only in this client. Choose your workspace language in its settings.',
    ],
    languageUnsaved: [
      '本次语言已切换，但未能保存。重新打开后将使用原设置。',
      'Language changed for this session, but could not be saved. The previous setting will apply next time.',
    ],
    languageInvalid: ['客户端语言无效。', 'Invalid client language.'],
    edit: ['编辑', 'Edit'],
    workspace: ['空间', 'Workspace'],
    view: ['显示', 'View'],
    window: ['窗口', 'Window'],
    help: ['帮助', 'Help'],
    keyboardShortcuts: ['键盘快捷键', 'Keyboard shortcuts'],
    searchConversations: ['搜索会话', 'Search conversations'],
    newGroupChat: ['新建群聊', 'New group chat'],
    openSettings: ['打开设置', 'Open settings'],
    sendInComposer: ['在输入框中发送消息', 'Send from the composer'],
    newLineInComposer: ['在输入框中换行', 'Insert a new line in the composer'],
    dictateInComposer: ['在输入框中听写', 'Dictate in the composer'],
    changeZoom: ['放大、缩小或重置缩放', 'Zoom in, zoom out, or reset zoom'],
    reconnect: ['重新连接', 'Reconnect'],
    reload: ['刷新页面', 'Reload page'],
    switchWorkspace: ['更换空间…', 'Change workspace…'],
    undo: ['撤销', 'Undo'],
    redo: ['重做', 'Redo'],
    cut: ['剪切', 'Cut'],
    copy: ['复制', 'Copy'],
    paste: ['粘贴', 'Paste'],
    selectAll: ['全选', 'Select All'],
    actualSize: ['实际大小', 'Actual Size'],
    zoomIn: ['放大', 'Zoom In'],
    zoomOut: ['缩小', 'Zoom Out'],
    fullScreen: ['切换全屏', 'Toggle Full Screen'],
    minimize: ['最小化', 'Minimize'],
    zoom: ['缩放窗口', 'Zoom Window'],
    front: ['全部置于前端', 'Bring All to Front'],
    about: ['关于 BambooShift', 'About BambooShift'],
    hide: ['隐藏 BambooShift', 'Hide BambooShift'],
    hideOthers: ['隐藏其他应用', 'Hide Others'],
    unhide: ['显示全部', 'Show All'],
    quit: ['退出 BambooShift', 'Quit BambooShift'],
    close: ['关闭窗口', 'Close Window'],
    external: ['外部链接', 'External link'],
    linkBlocked: ['此链接没有在 BambooShift 中打开。', 'This link was not opened in BambooShift.'],
    linkHelp: [
      '客户端只显示当前空间。需要访问网页时，请右键点击链接，选择“在浏览器打开链接”，并确认地址。',
      'The client displays only your current workspace. To visit a website, right-click its link, choose “Open Link in Browser”, and confirm the address.',
    ],
    gotIt: ['知道了', 'OK'],
    openLink: ['在浏览器打开链接', 'Open Link in Browser'],
    openLinkMenu: ['在浏览器打开链接…', 'Open Link in Browser…'],
    openOrigin: ['打开 {{origin}}？', 'Open {{origin}}?'],
    cancel: ['取消', 'Cancel'],
    openBrowser: ['打开浏览器', 'Open Browser'],
    saveFile: ['保存 BambooShift 文件', 'Save BambooShift File'],
    saveShared: ['保存共享资料', 'Save Shared File'],
    save: ['保存', 'Save'],
    notificationsAllow: [
      '允许 BambooShift 显示工作通知？',
      'Allow BambooShift work notifications?',
    ],
    notificationsHelp: [
      '只显示任务完成或需要确认的提醒，不显示对话内容。退出账户或更换空间后需重新允许。',
      'Show task completion and approval reminders without conversation content. Allow again after signing out or changing workspace.',
    ],
    notificationsEnable: ['允许通知', 'Allow notifications'],
    httpError: [
      '服务返回错误（{{status}}）。请检查所填地址，或稍后重试。',
      'The service returned an error ({{status}}). Check the address or try again later.',
    ],
    addressRequired: ['请先填写工作空间地址。', 'Enter a workspace address first.'],
    addressExample: [
      '请输入完整地址，例如 https://bot.example.com。',
      'Enter a full address, such as https://bot.example.com.',
    ],
    addressHome: [
      '请填写工作空间主页地址，不要包含页面路径、参数或登录信息。',
      'Enter the workspace home address without a page path, parameters, or sign-in details.',
    ],
    addressRemote: [
      '远程工作空间需要 https:// 地址；本机可使用 http://127.0.0.1:3001。',
      'Remote workspaces require https://. For a local workspace, use http://127.0.0.1:3001.',
    ],
    incomplete: [
      '连接没有完成，请检查地址与网络后重试。',
      'The connection did not complete. Check the address and network, then try again.',
    ],
    newAddress: [
      '输入新的地址，连接另一个工作空间。',
      'Enter a new address to connect to another workspace.',
    ],
    desktopOnly: [
      '请从 BambooShift 桌面应用打开这个页面。',
      'Open this page from the BambooShift desktop app.',
    ],
    stateFailed: [
      '暂时无法读取连接信息，请重试。',
      'Connection details could not be read. Please try again.',
    ],
    redirected: [
      '服务跳转到了其他地址。请确认正确地址后重新连接。',
      'The service redirected to another address. Confirm the correct address and reconnect.',
    ],
    certificate: [
      '服务证书验证失败。请使用有效的 HTTPS 证书；客户端不会跳过证书检查。',
      'The service certificate could not be verified. Use a valid HTTPS certificate; certificate checks cannot be skipped.',
    ],
    loadFailed: [
      '无法加载这个空间。请检查服务是否启动和网络连接，然后重试。',
      'This workspace could not be loaded. Check that the service is running and your network is connected, then try again.',
    ],
    rendererGone: [
      '空间页面意外退出。服务端任务不受影响，可以重新连接。',
      'The workspace page closed unexpectedly. Server tasks are unaffected. You can reconnect.',
    ],
    rendererClosed: [
      '空间页面已关闭。服务端任务不受影响，可以重新连接。',
      'The workspace page has closed. Server tasks are unaffected. You can reconnect.',
    ],
    timeout: [
      '连接超时。请检查网络和服务状态，然后重试相同地址。',
      'The connection timed out. Check your network and the service, then retry the same address.',
    ],
    connectFailed: [
      '无法连接这个空间。请检查地址、网络和服务状态，然后重试。',
      'This workspace could not be reached. Check the address, network, and service, then try again.',
    ],
    workspaceRequired: [
      '这个地址没有提供 BambooShift 工作空间。请核对团队给出的产品地址，或确认本机服务已经启动。',
      'This address did not respond as a BambooShift workspace. Check your team’s product address or make sure the local server has started.',
    ],
    setupFailed: [
      '连接页面无法加载，请重新安装客户端。',
      'The connection page could not be loaded. Please reinstall the client.',
    ],
    invalidParameters: ['连接参数无效。', 'Invalid connection parameters.'],
    setupOnly: [
      '此操作只允许从 BambooShift 连接页面发起。',
      'This action is available only from the BambooShift connection page.',
    ],
    serviceAddress: [
      '请输入完整的 BambooShift 服务地址。',
      'Enter the full BambooShift service address.',
    ],
    originOnly: [
      '只填写服务地址，不包含路径、查询参数或片段。',
      'Enter only the service address, without a path, query, or fragment.',
    ],
    invalidAddress: ['服务地址无效。', 'Invalid service address.'],
    noCredentials: [
      '服务地址不能包含账号或密码。',
      'The service address cannot contain a username or password.',
    ],
    fullOrigin: [
      '服务地址必须是一个完整来源地址。',
      'The service address must be a complete origin.',
    ],
    localHttpOnly: [
      '远程服务必须使用 HTTPS；只有 localhost、127.0.0.1 和 [::1] 可以使用 HTTP。',
      'Remote services require HTTPS. Only localhost, 127.0.0.1, and [::1] may use HTTP.',
    ],
    httpsOnly: ['服务地址必须使用 HTTPS。', 'The service address must use HTTPS.'],
    firstConnect: ['请先填写地址并点击连接。', 'Enter an address and click Connect first.'],
    authorizeClick: [
      '请在当前工作空间点击授权按钮。',
      'Click the authorization button in your current workspace.',
    ],
    authorizeFailed: [
      '未能打开授权页面，请检查账号与连接后重试。',
      'The authorization page could not be opened. Check your account and connection, then try again.',
    ],
    downloadClick: [
      '请在当前页面点击共享资料的下载按钮。',
      'Click the shared file download button on the current page.',
    ],
    downloadCancelled: [
      '下载已取消，页面或账户已变化。',
      'Download cancelled because the page or account changed.',
    ],
    grantChanged: [
      '共享资料或账户权限已变化，请刷新后重试。',
      'The shared file or account permissions changed. Refresh and try again.',
    ],
    oversized: ['下载内容超过允许大小。', 'The download exceeds the allowed size.'],
    accountUnknown: [
      '无法确认当前账户，请刷新后重试。',
      'Your current account could not be verified. Refresh and try again.',
    ],
    accountChanged: [
      '当前登录账户已变化，请刷新后重新下载。',
      'The signed-in account changed. Refresh and download again.',
    ],
    saveLocation: ['保存位置无效，请重新选择。', 'Invalid save location. Choose another location.'],
    notFolder: ['保存位置不是文件夹。', 'The save location is not a folder.'],
    ordinaryFile: [
      '请选择普通文件作为保存位置。',
      'Choose a regular file as the save destination.',
    ],
    locationChanged: [
      '保存位置发生变化，请重新选择。',
      'The save location changed. Choose it again.',
    ],
    fileChanged: [
      '原文件已经变化，未覆盖；请重新选择保存位置。',
      'The existing file changed and was not overwritten. Choose a save location again.',
    ],
    downloadFailed: [
      '共享资料未保存，请检查账户、权限和保存位置后重试。',
      'The shared file was not saved. Check your account, permissions, and save location, then try again.',
    ],
    cleanupUnknown: [
      '下载未保存，但本机临时文件的清理未能确认，请检查保存位置后重试。',
      'The download was not saved, and temporary file cleanup could not be confirmed. Check the save location before trying again.',
    ],
  };
  const catalogs = Object.fromEntries(
    locales.map((locale, index) => [
      locale,
      Object.freeze(
        Object.fromEntries(Object.entries(entries).map(([key, values]) => [key, values[index]])),
      ),
    ]),
  );
  function resolveLocale(value) {
    return typeof value === 'string' && /^zh(?:-|$)/i.test(value) ? 'zh-CN' : 'en';
  }
  function translate(locale, key, values = {}) {
    const catalog = catalogs[locales.includes(locale) ? locale : 'zh-CN'];
    const text = catalog[key] ?? catalogs['zh-CN'][key] ?? key;
    return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    );
  }
  function message(locale, value) {
    if (typeof value !== 'string') return translate(locale, 'incomplete');
    for (const [key, values] of Object.entries(entries)) {
      if (values.includes(value)) return translate(locale, key);
    }
    const status =
      /^(?:服务返回错误（(\d+)）。请检查所填地址，或稍后重试。|The service returned an error \((\d+)\)\. Check the address or try again later\.)$/.exec(
        value,
      );
    return status ? translate(locale, 'httpError', { status: status[1] || status[2] }) : value;
  }
  return Object.freeze({
    locales,
    catalogs: Object.freeze(catalogs),
    resolveLocale,
    translate,
    message,
  });
});
