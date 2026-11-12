'use strict';

(() => {
  const DEFAULT_URL = 'http://127.0.0.1:3001';
  const bridge = window.openbotDesktop;
  const languageApi = window.OpenBotClientLanguage;
  const languageSelect = document.getElementById('client-language');
  const languageStatus = document.getElementById('language-status');
  let locale = languageApi.resolveLocale(navigator.language);
  let visibleError = '',
    visibleNote = '';
  let languageOperation = 0;
  let active = true;
  const t = (key) => languageApi.translate(locale, key);
  function applyLanguage(value, persisted = true) {
    if (!languageApi.locales.includes(value)) return;
    locale = value;
    document.documentElement.lang = locale;
    languageSelect.value = locale;
    for (const attribute of ['data-i18n', 'data-i18n-alt', 'data-i18n-placeholder']) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        const text = t(element.getAttribute(attribute));
        if (attribute === 'data-i18n') element.textContent = text;
        else element.setAttribute(attribute.slice(10), text);
      }
    }
    languageStatus.hidden = persisted;
    languageStatus.textContent = persisted ? '' : t('languageUnsaved');
  }
  const form = document.getElementById('connect-form');
  const address = document.getElementById('workspace-url');
  const connectButton = document.getElementById('connect-button');
  const connectLabel = document.getElementById('connect-label');
  const spinner = document.getElementById('connect-spinner');
  const arrow = document.getElementById('connect-arrow');
  const localButton = document.getElementById('use-local');
  const changeButton = document.getElementById('change-address');
  const startLocalButton = document.getElementById('start-local');
  const startLocalLabel = document.getElementById('start-local-label');
  const localSpinner = document.getElementById('local-spinner');
  const localDescription = document.getElementById('local-description');
  const localErrorMessage = document.getElementById('local-error');
  const cancelLocalButton = document.getElementById('cancel-local');
  const hostControlOption = document.getElementById('host-control-option');
  const hostControlInput = document.getElementById('host-control');
  const errorPanel = document.getElementById('error-panel');
  const errorMessage = document.getElementById('error-message');
  const statusMessage = document.getElementById('connection-status');
  let status = 'loading';
  let localAvailable = false;
  let localStarting = false;
  let hostControlAvailable = false;
  let hostControlEdited = false;
  let localError = '';
  let lastAttemptUrl = '';
  let edited = false;
  let eventVersion = 0;
  let operation = 0;
  let unsubscribe;

  function render(nextStatus, error = '', note = '') {
    status = nextStatus;
    visibleError = error;
    visibleNote = note;
    document.body.hidden = status === 'connected';
    const busy =
      localStarting || status === 'loading' || status === 'connecting' || status === 'connected';
    startLocalButton.disabled = busy || !localAvailable || !bridge?.startLocal;
    hostControlOption.hidden = !hostControlAvailable;
    hostControlInput.disabled = busy;
    startLocalLabel.textContent = t(localStarting ? 'localRuntimeStarting' : 'startLocal');
    localSpinner.hidden = !localStarting;
    localDescription.textContent = t(
      localAvailable || status === 'loading' ? 'localWorkspaceNote' : 'localRuntimeUnavailable',
    );
    localErrorMessage.hidden = !localError;
    localErrorMessage.textContent = localError ? languageApi.message(locale, localError) : '';
    cancelLocalButton.hidden = !localStarting;
    cancelLocalButton.disabled = !bridge?.cancelLocal;
    form.setAttribute('aria-busy', String(busy));
    address.disabled = busy;
    languageSelect.disabled = localStarting || status === 'connecting' || status === 'connected';
    localButton.disabled = busy;
    connectButton.disabled = busy || !bridge;
    errorPanel.hidden = !error;
    errorMessage.textContent = languageApi.message(locale, error);
    address.setAttribute('aria-invalid', String(Boolean(error)));
    address.setAttribute('aria-describedby', error ? 'address-help error-message' : 'address-help');
    changeButton.hidden = !error || !bridge;
    spinner.hidden = localStarting || !busy;
    arrow.hidden = !localStarting && busy;
    connectLabel.textContent =
      status === 'loading'
        ? t('preparing')
        : status === 'connecting'
          ? t('connecting')
          : status === 'connected'
            ? t('opening')
            : status === 'error'
              ? t('retry')
              : t('connectWorkspace');
    statusMessage.textContent =
      languageApi.message(locale, note) ||
      (status === 'connecting' ? t('checking') : status === 'connected' ? t('connected') : '');
  }

  function applyState(state, first = false) {
    if (!state || typeof state !== 'object') return false;
    if (!['setup', 'connecting', 'connected', 'error'].includes(state.status)) return false;
    if (state.language) applyLanguage(state.language, state.languagePersisted !== false);
    localAvailable = state.localAvailable === true;
    localStarting = state.localStarting === true;
    hostControlAvailable = state.localHostControlAvailable === true;
    if (state.status === 'connected') hostControlEdited = false;
    if (!hostControlEdited) hostControlInput.checked = state.localHostControlSelected === true;
    localError = typeof state.localError === 'string' ? state.localError.slice(0, 1000) : '';
    const savedUrl = typeof state.url === 'string' && state.url ? state.url : DEFAULT_URL;
    if (first || !edited || state.status === 'connecting' || state.status === 'connected') {
      address.value = savedUrl;
      edited = false;
    }
    if (state.status === 'connecting' && !localStarting) lastAttemptUrl = savedUrl;
    render(state.status, typeof state.error === 'string' ? state.error.slice(0, 1000) : '');
    return true;
  }

  function workspaceUrl(value) {
    const raw = value.trim();
    if (!raw) throw new Error(t('addressRequired'));
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(t('addressExample'));
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(t('addressHome'));
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error(t('addressRemote'));
    }
    return url.origin;
  }

  async function connect(event) {
    event.preventDefault();
    if (localStarting || !bridge || ['loading', 'connecting', 'connected'].includes(status)) return;
    let url;
    try {
      url = workspaceUrl(address.value);
    } catch (error) {
      render('error', error.message);
      address.focus();
      return;
    }
    const retry = status === 'error' && url === lastAttemptUrl;
    const thisOperation = ++operation;
    address.value = url;
    edited = false;
    lastAttemptUrl = url;
    render('connecting');
    try {
      const result = retry ? await bridge.retry() : await bridge.connect({ url });
      if (thisOperation !== operation) return;
      if (!applyState(result)) applyState(await bridge.getState());
    } catch (error) {
      if (thisOperation !== operation) return;
      const message =
        error instanceof Error && !error.message.includes('Error invoking remote method')
          ? error.message
          : t('incomplete');
      render('error', message);
    }
  }

  async function localAction(method) {
    const ticket = ++operation;
    localStarting = method === 'startLocal';
    localError = '';
    render(status);
    try {
      const state =
        method === 'startLocal'
          ? await bridge.startLocal({
              hostControl: hostControlAvailable && hostControlInput.checked === true,
            })
          : await bridge.cancelLocal();
      if (ticket === operation) applyState(state);
    } catch {
      if (ticket !== operation) return;
      localStarting = false;
      localError = t('localRuntimeFailed');
      render('setup');
    }
  }

  hostControlInput.addEventListener('change', () => {
    hostControlEdited = true;
  });
  startLocalButton.addEventListener('click', () => {
    if (!startLocalButton.disabled) void localAction('startLocal');
  });
  cancelLocalButton.addEventListener('click', () => {
    if (localStarting && bridge?.cancelLocal) void localAction('cancelLocal');
  });
  form.addEventListener('submit', (event) => void connect(event));
  address.addEventListener('input', () => {
    edited = true;
    if (status === 'error') render('setup');
  });
  localButton.addEventListener('click', () => {
    address.value = DEFAULT_URL;
    edited = true;
    render('setup');
    address.focus();
  });
  changeButton.addEventListener('click', () => {
    edited = true;
    render('setup', '', t('newAddress'));
    address.focus();
    address.select();
  });
  window.addEventListener('pagehide', () => {
    active = false;
    operation += 1;
    languageOperation += 1;
    if (typeof unsubscribe === 'function') unsubscribe();
  });

  languageSelect.addEventListener('change', async () => {
    if (!active || !bridge?.setLanguage) return;
    const value = languageSelect.value;
    const ticket = ++languageOperation;
    try {
      const state = await bridge.setLanguage(value);
      if (!active || ticket !== languageOperation) return;
      applyLanguage(state.language, state.languagePersisted !== false);
      render(status, visibleError, visibleNote);
    } catch {
      if (!active || ticket !== languageOperation) return;
      languageSelect.value = locale;
      languageStatus.hidden = false;
      languageStatus.textContent = t('languageUnsaved');
    }
  });
  applyLanguage(locale);
  render('loading');
  async function initialize() {
    if (!bridge || typeof bridge.getState !== 'function' || typeof bridge.connect !== 'function') {
      render('error', t('desktopOnly'));
      return;
    }
    if (typeof bridge.onState === 'function') {
      unsubscribe = bridge.onState((state) => {
        eventVersion += 1;
        applyState(state);
      });
    }
    const before = eventVersion;
    try {
      const state = await bridge.getState();
      if (before === eventVersion) {
        if (!applyState(state, true)) render('setup');
      }
      if (status === 'setup') address.focus();
    } catch {
      if (before === eventVersion) render('error', t('stateFailed'));
    }
  }
  void initialize();
})();
