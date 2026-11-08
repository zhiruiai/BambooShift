/** Only Bot actions that change the visible work surface retain a result image.
 * Text entry and manual previews deliberately do not create history frames. */
export const framedComputerActionTypes = new Set<string>([
  'browser_navigate',
  'browser_click',
  'browser_scroll',
  'browser_back',
  'desktop_click',
  'desktop_key',
  'desktop_scroll',
  'desktop_drag',
]);

export const MAX_COMPUTER_FRAME_INPUT_BYTES = 10 * 1024 * 1024;
