import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';

type Rgb = [number, number, number];
function args(text: string) {
  const result: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result;
}
function color(value: string, vars: Record<string, string>, dark: boolean): Rgb {
  value = value.replace(/\s+/g, ' ').trim();
  if (/^#[a-f\d]{6}$/i.test(value))
    return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as Rgb;
  const fn = /^(var|light-dark|color-mix)\((.*)\)$/.exec(value);
  assert.ok(fn, `Unsupported tested color: ${value}`);
  const parts = args(fn[2]);
  if (fn[1] === 'var') return color(vars[parts[0]] ?? parts[1], vars, dark);
  if (fn[1] === 'light-dark') return color(parts[dark ? 1 : 0], vars, dark);
  assert.equal(parts[0], 'in srgb');
  const first = /^(.*) (\d+(?:\.\d+)?)%$/.exec(parts[1]);
  assert.ok(first, `Explicit first color weight: ${value}`);
  const fraction = Number(first[2]) / 100;
  const a = color(first[1], vars, dark),
    b = color(parts[2], vars, dark);
  return a.map((c, i) => c * fraction + b[i] * (1 - fraction)) as Rgb;
}
function luminance(rgb: Rgb) {
  return rgb
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a: Rgb, b: Rgb) {
  const aa = luminance(a),
    bb = luminance(b);
  return (Math.max(aa, bb) + 0.05) / (Math.min(aa, bb) + 0.05);
}
async function tokens(dark: boolean) {
  const css = postcss.parse(await readFile('web/src/theme.css', 'utf8'));
  const vars: Record<string, string> = {},
    accent: Record<string, string> = {};
  css.walkRules((rule) => {
    const target =
      rule.selector === ':root' || (dark && rule.selector === ":root[data-theme='dark']")
        ? vars
        : rule.selector === ".message-content[data-bot-accent='bot']"
          ? accent
          : undefined;
    if (target)
      rule.walkDecls((decl) => {
        if (decl.prop.startsWith('--')) target[decl.prop] = decl.value;
      });
  });
  return { vars, accent };
}

test('shared theme text and status colors meet normal-text contrast on supported surfaces', async () => {
  for (const dark of [false, true]) {
    const { vars } = await tokens(dark);
    const check = (foreground: string, background: string) => {
      const ratio = contrast(
        color(vars[foreground], vars, dark),
        color(vars[background], vars, dark),
      );
      assert.ok(
        ratio >= 4.5,
        `${dark ? 'dark' : 'light'} ${foreground} on ${background}: ${ratio.toFixed(2)}`,
      );
    };
    for (const foreground of ['--text', '--text-secondary', '--text-muted'])
      for (const background of [
        '--bg-canvas',
        '--surface',
        '--surface-subtle',
        '--surface-hover',
        '--surface-raised',
      ])
        check(foreground, background);
    for (const status of ['accent', 'success', 'warning', 'danger', 'info'])
      check(`--${status}`, `--${status}-soft`);
    check('--solid-ink', '--solid');
  }
});

test('actual Bot accent color formulas keep text readable across bright, dark and saturated Bot colors', async () => {
  for (const dark of [false, true]) {
    const { vars, accent } = await tokens(dark);
    for (const r of [0, 51, 102, 153, 204, 255])
      for (const g of [0, 51, 102, 153, 204, 255])
        for (const b of [0, 51, 102, 153, 204, 255]) {
          vars['--message-bot-color'] =
            '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
          const ratio = contrast(
            color(accent['--message-accent-ink'], vars, dark),
            color(accent['--message-accent-soft'], vars, dark),
          );
          assert.ok(
            ratio >= 4.5,
            `${dark ? 'dark' : 'light'} Bot ${vars['--message-bot-color']}: ${ratio.toFixed(2)}`,
          );
        }
    delete vars['--message-bot-color'];
    const fallback = contrast(
      color(accent['--message-accent-ink'], vars, dark),
      color(accent['--message-accent-soft'], vars, dark),
    );
    assert.ok(fallback >= 4.5, 'missing historical Bot color has a readable fallback');
  }
});
