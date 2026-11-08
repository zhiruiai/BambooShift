export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const svgTags = new Set(
  'svg g rect circle ellipse line polyline polygon path text tspan'.split(' '),
);
const numbers = new Set(
  'x y x1 x2 y1 y2 cx cy r rx ry dx dy width height stroke-width stroke-dasharray opacity fill-opacity stroke-opacity points viewBox'.split(
    ' ',
  ),
);

export function copyPreviewSvg(node: Element, output: Document): Element | undefined {
  if (!svgTags.has(node.localName)) return;
  const element = output.createElementNS(SVG_NAMESPACE, node.localName);
  for (const { name, value } of Array.from(node.attributes)) {
    if (value.length > 16384) continue;
    if (numbers.has(name) && /^[\d.eE, +%-]+$/.test(value)) element.setAttribute(name, value);
    if (
      ['fill', 'stroke', 'color'].includes(name) &&
      (value === 'none' || CSS.supports('color', value))
    )
      element.setAttribute(name, value);
    if (name === 'd' && /^[MmLlHhVvCcSsQqTtAaZz\d.eE, +\-]+$/.test(value))
      element.setAttribute(name, value);
    if (
      name === 'transform' &&
      /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d.eE, +\-]+\)\s*)+$/.test(value)
    )
      element.setAttribute(name, value);
    if (
      [
        'text-anchor',
        'dominant-baseline',
        'font-weight',
        'stroke-linecap',
        'stroke-linejoin',
      ].includes(name) &&
      /^[A-Za-z0-9-]{1,24}$/.test(value)
    )
      element.setAttribute(name, value);
    if (name === 'font-size' && /^\d+(?:\.\d+)?$/.test(value))
      element.setAttribute(name, String(Math.max(12, Number(value))));
  }
  return element;
}
