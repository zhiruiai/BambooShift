// This script runs in a dedicated worker, never in a Window or the application origin.
export const WEBSITE_WORKER_RUNTIME = String.raw`
(() => {
  'use strict';
  const runClassic = importScripts.bind(self);
  const send = postMessage.bind(self);
  const listen = addEventListener.bind(self);
  const blocked = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'Worker', 'SharedWorker', 'BroadcastChannel',
    'indexedDB', 'caches', 'importScripts'];
  for (const name of blocked) {
    for (let target = self; target && target !== Object.prototype; target = Object.getPrototypeOf(target)) {
      if (target === self || Object.hasOwn(target, name)) {
        try { Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false }); } catch {}
      }
    }
  }

  listen('message', async function init(message) {
    const config = message.data;
    if (config?.kind !== 'init') return;
    removeEventListener('message', init);
    const rows = config.elements;
    const handles = new Map();
    const body = new EventTarget();
    const canvas = config.canvas || null;
    let pointerLockElement = null;
    const viewport = { width: config.width, height: config.height };
    const limits = (value, maximum) => Math.max(1, Math.min(maximum, Math.round(Number(value) || 1)));
    const emit = (op, id, value) => send({ kind: 'op', op, id, value });
    const validClass = (name) => typeof name === 'string' && /^[\w-]{1,80}$/.test(name);
    const style = (id) => new Proxy(Object.create(null), {
      set(_, name, value) {
        if (typeof name === 'string' && typeof value === 'string' && value.length <= 256)
          emit('style', id, [name, value]);
        return true;
      },
    });
    const mount = (id) => (node) => {
      if (!canvas || node !== canvas) throw Error('Only the preview canvas can be attached.');
      emit('mount', id, '');
      return node;
    };

    if (canvas) {
      const nativeContext = canvas.getContext.bind(canvas);
      const proto = OffscreenCanvas.prototype;
      for (const name of ['width', 'height']) {
        const dimension = Object.getOwnPropertyDescriptor(proto, name);
        Object.defineProperty(canvas, name, {
          get: () => dimension.get.call(canvas),
          set: (value) => dimension.set.call(canvas, limits(value, 2048)),
        });
      }
      Object.defineProperties(canvas, {
        getContext: { value: (...args) => { emit('canvas', '', ''); return nativeContext(...args); } },
        style: { value: style('canvas') },
        clientWidth: { get: () => viewport.width },
        clientHeight: { get: () => viewport.height },
        ownerDocument: { get: () => document },
        getRootNode: { value: () => document },
        getBoundingClientRect: { value: () => ({ x: 0, y: 0, left: 0, top: 0,
          right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height }) },
        setPointerCapture: { value: () => {} },
        releasePointerCapture: { value: () => {} },
        requestPointerLock: { value: () => emit('pointer-lock', 'canvas', '') },
      });
    }

    function handle(row) {
      if (!row) return null;
      if (row.tag === 'canvas') return canvas;
      if (handles.has(row.key)) return handles.get(row.key);
      const item = new EventTarget();
      const classes = new Set(row.classes);
      let text = row.text;
      let value = row.value;
      const classList = {
        contains: (name) => classes.has(name),
        add: (...names) => { names.filter(validClass).forEach(name => classes.add(name)); updateClass(); },
        remove: (...names) => { names.forEach(name => classes.delete(name)); updateClass(); },
        toggle: (name, force = !classes.has(name)) => {
          if (validClass(name)) { if (force) classes.add(name); else classes.delete(name); updateClass(); }
          return classes.has(name);
        },
      };
      function updateClass() { emit('class', row.key, Array.from(classes).slice(0, 40).join(' ')); }
      Object.defineProperties(item, {
        id: { value: row.id },
        tagName: { value: row.tag.toUpperCase() },
        style: { value: style(row.key) },
        classList: { value: classList },
        textContent: { get: () => text, set: (next) => { text = String(next).slice(0, 4000); emit('text', row.key, text); } },
        innerText: { get: () => text, set: (next) => { item.textContent = next; } },
        value: { get: () => value, set: (next) => { value = String(next).slice(0, 1000); emit('value', row.key, value); } },
        dataset: { value: Object.freeze(row.data) },
        appendChild: { value: mount(row.key) },
      });
      for (const type of ['click', 'input', 'change']) {
        let handler = null;
        item.addEventListener(type, (event) => handler?.call(item, event));
        Object.defineProperty(item, 'on' + type, {
          get: () => handler,
          set: (value) => { handler = typeof value === 'function' ? value : null; },
        });
      }
      handles.set(row.key, item);
      return item;
    }

    function queryAll(selector) {
      if (typeof selector !== 'string' || selector.length > 80) return [];
      const simple = /^([a-z][\w-]*)?([#.][\w-]+)?$/i.exec(selector.trim());
      if (!simple || !simple[1] && !simple[2]) return [];
      return rows.filter(row => (!simple[1] || row.tag === simple[1].toLowerCase()) &&
        (!simple[2] || (simple[2][0] === '#' ? row.id === simple[2].slice(1) : row.classes.includes(simple[2].slice(1)))))
        .map(handle).filter(Boolean);
    }

    const createElement = (tag) => {
      if (String(tag).toLowerCase() === 'canvas') return canvas;
      throw Error('Element creation is unavailable in this preview.');
    };
    body.appendChild = mount('');
    body.requestPointerLock = () => emit('pointer-lock', 'body', '');
    const documentEvents = new EventTarget();
    const document = {
      body, documentElement: body, readyState: 'complete',
      createElement, createElementNS: (_, tag) => createElement(tag),
      getElementById: (id) => handle(rows.find(row => row.id === id)),
      querySelector: (selector) => queryAll(selector)[0] || null,
      querySelectorAll: queryAll,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      get pointerLockElement() { return pointerLockElement; },
      exitPointerLock: () => emit('pointer-unlock', '', ''),
    };
    Object.defineProperties(self, {
      window: { value: self }, document: { value: document },
      innerWidth: { get: () => viewport.width }, innerHeight: { get: () => viewport.height },
      devicePixelRatio: { value: 1 },
    });

    listen('message', ({ data }) => {
      if (data?.kind === 'ping') { send({ kind: 'pong' }); return; }
      if (data?.kind === 'pointer-lock') {
        pointerLockElement = data.target === 'canvas' ? canvas : data.target === 'body' ? body : null;
        documentEvents.dispatchEvent(new Event(data.error ? 'pointerlockerror' : 'pointerlockchange'));
        return;
      }
      if (data?.kind === 'resize') {
        viewport.width = data.width;
        viewport.height = data.height;
        dispatchEvent(new Event('resize'));
      }
      if (data?.kind !== 'event') return;
      const target = data.key === 'canvas' ? canvas : handle(rows.find(row => row.key === data.key));
      if (target && target !== canvas && typeof data.value === 'string') target.value = data.value;
      const event = new Event(data.type, { cancelable: true });
      for (const [name, value] of Object.entries(data.properties || {}))
        Object.defineProperty(event, name, { value });
      target?.dispatchEvent(event);
      documentEvents.dispatchEvent(event);
      dispatchEvent(event);
    });
    try {
      for (const entry of config.entries) {
        if (entry.module) await import(entry.url);
        else runClassic(entry.url);
      }
      documentEvents.dispatchEvent(new Event('DOMContentLoaded'));
      dispatchEvent(new Event('load'));
      send({ kind: 'ready' });
    } catch { send({ kind: 'error' }); }
  });
})();
`;

// Only this fixed bridge is allowed to run in the opaque preview frame.
export const WEBSITE_FRAME_RUNTIME = String.raw`
(() => {
  'use strict';
  const payload = document.currentScript.previousElementSibling;
  const data = JSON.parse(payload.textContent);
  const status = payload.previousElementSibling;
  const announce = (kind, value) => parent.postMessage({ channel: data.channel, kind, value }, '*');
  const links = document.querySelectorAll('[data-ob-project-link]');
  for (const link of links) {
    const follow = event => {
      if (!event.isTrusted) return;
      event.preventDefault();
      const target = link.dataset.obProjectLink;
      if (target.startsWith('#')) document.getElementById(target.slice(1))?.scrollIntoView();
      else announce('navigate', target);
    };
    link.addEventListener('click', follow);
    link.addEventListener('keydown', event => { if (event.key === 'Enter') follow(event); });
  }
  if (!data.entries.length) return;
  const urls = new Map();
  const objectUrl = code => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  function scriptUrl(index) {
    if (urls.has(index)) return urls.get(index);
    const script = data.scripts[index];
    let code = script.code;
    for (const part of script.imports.slice().reverse())
      code = code.slice(0, part.from) + scriptUrl(part.index) + code.slice(part.to);
    const url = objectUrl(code);
    urls.set(index, url);
    return url;
  }

  const canvas = document.querySelector('[data-ob-project-canvas]');
  const nodes = new Map(Array.from(document.querySelectorAll('[data-ob-project-node]'),
    node => [node.dataset.obProjectNode, node]));
  let worker;
  let workerUrl;
  let timer;
  let heartbeat;
  let lastPong = 0;
  let resize;
  let pointerGesture = 0;
  function releasePointer() {
    if (document.pointerLockElement && (document.pointerLockElement === canvas || document.pointerLockElement === document.body)) {
      try { document.exitPointerLock(); } catch {}
    }
  }
  function close() {
    clearTimeout(timer);
    clearInterval(heartbeat);
    pointerGesture = 0;
    releasePointer();
    resize?.disconnect();
    worker?.terminate();
    worker = undefined;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
  }
  function fail() { close(); status.textContent = data.scriptError; }
  addEventListener('pagehide', close, { once: true });
  const styleProperties = new Set(['color', 'backgroundColor', 'opacity', 'display', 'visibility',
    'width', 'height', 'left', 'top', 'transform', 'fontWeight', 'textAlign', 'touchAction']);
  let updates = 0;
  try {
    const entries = data.entries.map(index => ({ url: scriptUrl(index), module: data.scripts[index].module }));
    workerUrl = objectUrl(data.runtime);
    worker = new Worker(workerUrl);
    worker.addEventListener('error', fail, { once: true });
    worker.addEventListener('messageerror', fail, { once: true });
    worker.addEventListener('message', ({ data: message }) => {
      if (message?.kind === 'ready') {
        clearTimeout(timer);
        if (!heartbeat) {
          lastPong = performance.now();
          heartbeat = setInterval(() => {
            if (performance.now() - lastPong > 8000) fail();
            else worker?.postMessage({ kind: 'ping' });
          }, 3000);
        }
        return;
      }
      if (message?.kind === 'pong') { lastPong = performance.now(); return; }
      if (message?.kind === 'error') { fail(); return; }
      if (message?.kind !== 'op') return;
      if (++updates > 20000) { fail(); return; }
      const { op, id, value } = message;
      if (op === 'pointer-unlock') { releasePointer(); return; }
      if (op === 'pointer-lock') {
        const target = id === 'canvas' ? canvas : id === 'body' ? document.body : null;
        if (!target || performance.now() > pointerGesture || !navigator.userActivation?.isActive) return;
        pointerGesture = 0;
        try {
          Promise.resolve(target.requestPointerLock()).catch(() => worker?.postMessage({ kind: 'pointer-lock', error: true }));
        } catch { worker?.postMessage({ kind: 'pointer-lock', error: true }); }
        return;
      }
      if (op === 'canvas' && canvas) { canvas.hidden = false; return; }
      if (op === 'mount' && canvas) {
        const parent = id === '' ? document.body : nodes.get(id);
        if (parent && /^(?:body|div|main|section|article|figure|aside)$/i.test(parent.tagName)) {
          parent.append(canvas);
          canvas.hidden = false;
        }
        return;
      }
      const node = id === 'canvas' ? canvas : nodes.get(id);
      if (!node) return;
      if (op === 'text' && typeof value === 'string' && value.length <= 4000 &&
        !node.querySelector('[data-ob-project-node], [data-ob-project-link], canvas')) node.textContent = value;
      if (op === 'class' && typeof value === 'string' && value.length <= 3240 && /^[\w -]*$/.test(value)) node.className = value;
      if (op === 'value' && typeof value === 'string' && value.length <= 1000 && node instanceof HTMLInputElement && node.value !== value) node.value = value;
      if (op === 'style' && Array.isArray(value) && styleProperties.has(value[0]) &&
        typeof value[1] === 'string' && value[1].length <= 256 && !/[\\<>]|url\s*\(/i.test(value[1])) node.style[value[0]] = value[1];
    });
    const elements = Array.from(nodes, ([key, node]) => ({
      key, id: node.id, tag: node.localName, classes: Array.from(node.classList).slice(0, 40),
      text: node.textContent.slice(0, 4000), value: typeof node.value === 'string' ? node.value.slice(0, 1000) : '',
      data: Object.fromEntries(Object.entries(node.dataset).filter(([name]) => !name.startsWith('obProject')).slice(0, 30)),
    }));
    const size = () => ({ width: Math.min(2048, Math.max(1, innerWidth)), height: Math.min(2048, Math.max(1, innerHeight)) });
    let offscreen;
    if (canvas && typeof canvas.transferControlToOffscreen === 'function') {
      canvas.width = Math.min(canvas.width || 960, 2048);
      canvas.height = Math.min(canvas.height || 540, 2048);
      offscreen = canvas.transferControlToOffscreen();
    }
    worker.postMessage({ kind: 'init', canvas: offscreen, elements, entries, ...size() }, offscreen ? [offscreen] : []);
    timer = setTimeout(fail, 6000);
    resize = new ResizeObserver(() => worker?.postMessage({ kind: 'resize', ...size() }));
    resize.observe(document.documentElement);
    document.addEventListener('pointerlockchange', () => {
      const target = document.pointerLockElement;
      worker?.postMessage({ kind: 'pointer-lock', target: target && target === canvas ? 'canvas' : target === document.body ? 'body' : null });
    });
    document.addEventListener('pointerlockerror', () => worker?.postMessage({ kind: 'pointer-lock', error: true }));
    for (const type of ['click', 'input', 'change', 'pointerdown', 'pointermove', 'pointerup', 'mousemove', 'keydown', 'keyup', 'wheel']) {
      document.addEventListener(type, event => {
        if (!worker || !event.isTrusted || !(event.target instanceof Element)) return;
        const node = event.target.closest('[data-ob-project-node], [data-ob-project-canvas]');
        if (type === 'click' && node && !event.target.closest('[data-ob-project-link], input, label')) {
          pointerGesture = performance.now() + 600;
        }
        const key = node === canvas ? 'canvas' : node?.dataset.obProjectNode || '';
        const properties = {};
        for (const prop of ['button', 'buttons', 'pointerId', 'clientX', 'clientY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'deltaX', 'deltaY', 'key', 'code']) {
          const value = event[prop];
          if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 30)
            properties[prop] = value;
        }
        const value = node instanceof HTMLInputElement ? node.value.slice(0, 1000) : undefined;
        worker.postMessage({ kind: 'event', key, type, value, properties });
      }, { passive: true });
    }
  } catch { fail(); }
})();
`;
