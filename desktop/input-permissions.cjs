'use strict';
const { sameOrigin } = require('./security.cjs');
function createInputPermissions({ getConnection, getWindow, machine, now }) {
  function foregroundFrame(contents, origin) {
    try {
      if (
        !getWindow() ||
        getWindow().isDestroyed() ||
        !getWindow().isVisible() ||
        !getWindow().isFocused() ||
        getWindow().isMinimized() ||
        !getConnection()?.attached ||
        machine.snapshot().status !== 'connected' ||
        getConnection().origin !== origin ||
        getConnection().view.webContents !== contents ||
        contents.isDestroyed() ||
        !contents.isFocused() ||
        contents.isLoadingMainFrame()
      )
        return;
      const frame = contents.mainFrame;
      if (
        !frame ||
        frame.isDestroyed() ||
        frame.detached ||
        contents.focusedFrame !== frame ||
        frame.visibilityState !== 'visible' ||
        frame.origin !== origin ||
        !sameOrigin(frame.url, origin) ||
        contents.getURL() !== frame.url
      )
        return;
      return frame;
    } catch {
      return;
    }
  }
  function consumeClipboardWrite(contents, details, origin) {
    const current = getConnection();
    const token = current?.clipboardInput;
    if (current) current.clipboardInput = undefined;
    const frame = foregroundFrame(contents, origin);
    return (
      !!frame &&
      !!token &&
      token.frame === frame &&
      token.url === frame.url &&
      now() < token.expiresAt &&
      details?.isMainFrame === true &&
      details.requestingUrl === frame.url
    );
  }
  function consumeMicrophone(contents, details, origin) {
    const current = getConnection();
    const token = current?.microphoneInput;
    if (current) current.microphoneInput = undefined;
    const frame = foregroundFrame(contents, origin);
    return (
      !!frame &&
      !!token &&
      token.frame === frame &&
      token.url === frame.url &&
      now() < token.expiresAt &&
      details?.isMainFrame === true &&
      details.requestingUrl === frame.url &&
      Array.isArray(details.mediaTypes) &&
      details.mediaTypes.length === 1 &&
      details.mediaTypes[0] === 'audio' &&
      (!details.securityOrigin || sameOrigin(details.securityOrigin, origin))
    );
  }
  function bindNativeInput(contents, current) {
    const clear = () => {
      current.clipboardInput = undefined;
      current.microphoneInput = undefined;
      current.oauthInput = undefined;
      current.sharedFileInput = undefined;
      current.notificationInput = undefined;
    };
    const arm = (microphoneOnly = false) => {
      clear();
      const frame = foregroundFrame(contents, current.origin);
      if (frame) {
        if (!microphoneOnly)
          current.oauthInput = { frame, url: frame.url, expiresAt: now() + 5000 };
        if (!microphoneOnly)
          current.sharedFileInput = { frame, url: frame.url, expiresAt: now() + 5000 };
        if (!microphoneOnly)
          current.notificationInput = { frame, url: frame.url, expiresAt: now() + 5000 };
        if (!microphoneOnly)
          current.clipboardInput = { frame, url: frame.url, expiresAt: now() + 1000 };
        current.microphoneInput = { frame, url: frame.url, expiresAt: now() + 5000 };
      }
    };
    // These events originate in the native WebContents input pipeline, not a
    // renderer-supplied IPC flag or a synthetic DOM click. No clipboard reads.
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') clear();
      if (input.type === 'mouseUp' && input.button === 'left') arm();
    });
    contents.on('before-input-event', (_event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key?.toLowerCase() === 'd' &&
        (input.control || input.meta) &&
        !input.alt &&
        !input.shift &&
        !input.isAutoRepeat &&
        !input.isComposing
      ) {
        arm(true);
        return;
      }
      if (input.isAutoRepeat || input.isComposing || input.control || input.meta || input.alt)
        return;
      if (
        (input.type === 'keyDown' && input.key === 'Enter') ||
        (input.type === 'keyUp' && input.key === ' ')
      )
        arm();
    });
    for (const event of ['blur', 'did-start-navigation', 'did-navigate-in-page', 'destroyed'])
      contents.on(event, clear);
  }

  return { foregroundFrame, consumeClipboardWrite, consumeMicrophone, bindNativeInput };
}
module.exports = { createInputPermissions };
