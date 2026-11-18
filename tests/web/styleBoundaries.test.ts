import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import postcss from 'postcss';

async function styles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? styles(`${directory}/${entry.name}`)
          : entry.name.endsWith('.css')
            ? [`${directory}/${entry.name}`]
            : [],
      ),
    )
  ).flat();
}
test('product and native styles keep readable typography, bounded modules and valid ordered imports', async () => {
  const surfaces = ['web/src', 'operations/src', 'desktop/ui'];
  for (const file of (await Promise.all(surfaces.map(styles))).flat()) {
    const css = await readFile(file, 'utf8');
    assert.ok(css.trimEnd().split('\n').length <= 500, `${file}: exceeds 500 lines`);
    const root = postcss.parse(css, { from: file });
    root.walkDecls((declaration) => {
      if (!['font', 'font-size'].includes(declaration.prop)) return;
      for (const value of declaration.value.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)px(?=\/|\s|$)/g))
        assert.ok(
          Number(value[1]) >= 12,
          `${file}:${declaration.source?.start?.line} has ${value[1]}px type`,
        );
    });
    let hasDeclaration = false;
    for (const node of root.nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'atrule' && node.name === 'import') {
        assert.doesNotMatch(node.params, /@import/, `${file}: adjacent imports need a terminator`);
        assert.equal(hasDeclaration, false, `${file}: imports must precede selectors`);
        const relative = node.params.match(/^['"](\.\/[^'"]+)['"]$/)?.[1];
        if (relative) await readFile(resolve(dirname(file), relative));
      } else hasDeclaration = true;
    }
  }
});
