import { websitePreviewDocument, websitePreviewToken } from './websitePreviewDocument';
import { websiteFiles } from './websitePreviewFiles';

type Payload = {
  files: { path: string; mime: string; base64: string }[];
  entry: string;
  documentTitle: string;
  homeLabel: string;
  scriptError: string;
  partial: string;
  loadFailed: string;
};

const page = document.querySelector<HTMLIFrameElement>('#preview')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
const home = toolbar.querySelector<HTMLButtonElement>('button')!;
const path = toolbar.querySelector<HTMLElement>('span')!;

let chunks: string[] = [];
let length = 0;
let mounted = false;
const maximum = 15 * 1024 * 1024;

Object.assign(globalThis, {
  openbotAppendProjectPreview(chunk: string) {
    if (mounted || typeof chunk !== 'string' || (length += chunk.length) > maximum) {
      throw Error('Invalid preview payload.');
    }
    chunks.push(chunk);
  },
  openbotRenderProjectPreview() {
    if (mounted) return;
    mounted = true;
    let payload: Payload | undefined;
    try {
      payload = JSON.parse(chunks.join('')) as Payload;
      const { files, entry, documentTitle, homeLabel, scriptError, partial, loadFailed } = payload;
      if (!Array.isArray(files) || files.length < 1 || files.length > 64) {
        throw Error('Invalid preview file count.');
      }
      const index = websiteFiles(
        files.map(({ path, mime, base64 }) => ({
          path,
          mime,
          bytes: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
        })),
      );
      page.title = documentTitle;
      home.textContent = homeLabel;
      let channel = '';
      const navigate = (current: string) => {
        try {
          channel = websitePreviewToken();
          page.srcdoc = websitePreviewDocument(index, current, { channel, scriptError, partial });
          page.hidden = false;
          status.hidden = true;
          toolbar.hidden = entry === current;
          path.textContent = current;
        } catch {
          page.hidden = true;
          toolbar.hidden = entry === current;
          status.hidden = false;
          status.textContent = loadFailed;
        }
      };
      home.addEventListener('click', () => navigate(entry));
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (
          event.source === page.contentWindow &&
          event.origin === 'null' &&
          message?.channel === channel &&
          message?.kind === 'navigate' &&
          typeof message.value === 'string' &&
          index.get(message.value)?.mime === 'text/html'
        )
          navigate(message.value);
      });
      navigate(entry);
    } catch {
      status.hidden = false;
      status.textContent = payload?.loadFailed || 'Preview unavailable.';
    } finally {
      chunks = [];
    }
  },
});
