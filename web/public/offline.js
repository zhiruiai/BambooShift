try {
  const saved = JSON.parse(localStorage.getItem('openbot-language') || 'null');
  if (saved?.version === 1 && saved.locale === 'en') {
    document.documentElement.lang = 'en';
    document.title = 'BambooShift · Waiting for connection';
    document.getElementById('offline-heading').textContent = 'Workspace is temporarily unavailable';
    document.getElementById('offline-message').textContent =
      'Check your connection and the BambooShift service, then try again. Tasks run on the server; reconnect to see their latest progress.';
    document.getElementById('offline-reconnect').textContent = 'Reconnect';
  }
} catch {
  // The default language remains available when local preferences cannot be read.
}
