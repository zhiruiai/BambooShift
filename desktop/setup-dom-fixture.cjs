'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createContext, runInContext } = require('node:vm');

// Execute the shipped setup scripts against elements parsed from the actual HTML.
function setupDom(bridge, language = 'en-US') {
  const elements = [];
  for (const match of readFileSync(join(__dirname, 'ui/index.html'), 'utf8').matchAll(
    /<([a-z][\w-]*)([^>]*)>/g,
  )) {
    const attributes = Object.fromEntries(
      [...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]]),
    );
    const listeners = new Map();
    elements.push({
      tag: match[1],
      attributes,
      textContent: '',
      value: attributes.value || '',
      hidden: /\bhidden\b/.test(match[2]),
      disabled: /\bdisabled\b/.test(match[2]),
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name];
      },
      addEventListener(name, handler) {
        listeners.set(name, handler);
      },
      emit(name) {
        return listeners.get(name)?.({ preventDefault() {} });
      },
      focus() {
        this.focused = true;
      },
      select() {
        this.selected = true;
      },
    });
  }
  const byId = (id) => elements.find((element) => element.attributes.id === id);
  const pageEvents = new Map();
  const document = {
    body: elements.find((element) => element.tag === 'body'),
    documentElement: elements.find((element) => element.tag === 'html'),
    getElementById: byId,
    querySelectorAll: (selector) =>
      elements.filter((element) => Object.hasOwn(element.attributes, selector.slice(1, -1))),
  };
  const window = {
    openbotDesktop: bridge,
    addEventListener: (name, handler) => pageEvents.set(name, handler),
  };
  const context = createContext({ window, document, navigator: { language }, URL, console });
  runInContext(readFileSync(join(__dirname, 'ui/i18n.js'), 'utf8'), context);
  window.OpenBotClientLanguage = context.OpenBotClientLanguage;
  runInContext(readFileSync(join(__dirname, 'ui/app.js'), 'utf8'), context);
  return { byId, document, elements, hide: () => pageEvents.get('pagehide')?.() };
}
module.exports = { setupDom };
