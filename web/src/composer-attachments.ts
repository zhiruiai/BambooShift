/** Read only files supplied by this paste gesture, not the system clipboard. */
export function pastedFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files);
  if (files.length) return files;
  return Array.from(clipboard.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
