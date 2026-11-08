import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const postcss = require('postcss');

/** Static declarations supplement the browser's computed-font acceptance. */
export function smallFonts(file) {
  if (!file.path.endsWith('.css')) return [];
  const violations = [];
  postcss.parse(file.text, { from: file.path }).walkDecls((declaration) => {
    if (!['font-size', 'font'].includes(declaration.prop.toLowerCase())) return;
    for (const size of declaration.value.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)) {
      if (Number(size[1]) < 12)
        violations.push({
          line: declaration.source.start.line,
          message: `Font size ${size[1]}px is below 12px.`,
        });
      // In shorthand, later pixel values can be line-height or other metadata.
      if (declaration.prop.toLowerCase() === 'font') break;
    }
  });
  return violations;
}
