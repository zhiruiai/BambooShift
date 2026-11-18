export function matchesTestSuite(file, mode) {
  const parts = file.split(/[\\/]/);
  const name = parts.pop();
  if (!/\.test\.(?:ts|tsx|mjs|cjs|js)$/.test(name)) return false;
  const browserOnly = parts.includes('browser') || name.includes('.browser.test.');
  if (mode !== 'browser') return !browserOnly;
  // These runtime tests also exercise Chrome when the browser suite opts in.
  return browserOnly || name === 'browser-engine.test.ts' || name === 'browser-download.test.ts';
}
