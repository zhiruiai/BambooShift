const properties = new Set(
  (
    'color background background-color background-image background-position background-size background-repeat background-origin background-clip background-attachment opacity display visibility position top right bottom left z-index ' +
    'width height min-width min-height max-width max-height margin margin-top margin-right margin-bottom margin-left ' +
    'padding padding-top padding-right padding-bottom padding-left box-sizing overflow overflow-x overflow-y ' +
    'border border-width border-style border-color border-top border-right border-bottom border-left border-radius ' +
    'border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius ' +
    'border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color ' +
    'transform transform-origin transition transition-property transition-duration transition-timing-function transition-delay cursor ' +
    'animation animation-name animation-duration animation-delay animation-direction animation-fill-mode animation-iteration-count animation-play-state animation-timing-function ' +
    'border-collapse border-spacing outline outline-color outline-width outline-style box-shadow ' +
    'font-family font-size font-style font-weight font-variant line-height letter-spacing word-spacing ' +
    'text-align text-indent text-decoration text-transform text-overflow text-shadow white-space word-break overflow-wrap ' +
    'vertical-align list-style-type list-style-position table-layout float clear ' +
    'flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap align-content align-items align-self ' +
    'justify-content justify-items justify-self gap row-gap column-gap order ' +
    'grid grid-area grid-template grid-template-columns grid-template-rows grid-template-areas ' +
    'grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row grid-column-start grid-column-end ' +
    'grid-row-start grid-row-end break-before break-after break-inside page-break-before page-break-after page-break-inside'
  ).split(' '),
);

export function safeDeclarations(style: CSSStyleDeclaration): string {
  const output = document.createElement('span').style;
  const entries = Array.from(style);
  if (entries.includes('font'))
    entries.push('font-family', 'font-size', 'font-style', 'font-weight', 'line-height');
  for (const name of entries) {
    let value = style.getPropertyValue(name);
    if (
      !properties.has(name) ||
      !value ||
      /\\|url\s*\(|image-set\s*\(|(?:https?|data|blob):|\/\//i.test(value)
    )
      continue;
    if (
      name === 'background-image' &&
      value !== 'none' &&
      !/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value)
    )
      continue;
    if (name === 'font-size') {
      const bounded = `max(12px, ${value})`;
      value = CSS.supports('font-size', bounded) ? bounded : '12px';
    }
    output.setProperty(name, value, style.getPropertyPriority(name));
  }
  return output.cssText;
}

export function safeStyles(text: string): string {
  if (text.length > 262144) return '';
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    let count = 0;
    const rules = (list: CSSRuleList, depth = 0): string => {
      if (depth > 8) return '';
      return Array.from(list)
        .map((rule) => {
          if (++count > 1000) return '';
          if (rule instanceof CSSStyleRule)
            return `${rule.selectorText}{${safeDeclarations(rule.style)}}`;
          if (rule instanceof CSSKeyframesRule)
            return `@keyframes ${CSS.escape(rule.name)}{${Array.from(rule.cssRules)
              .filter((step): step is CSSKeyframeRule => step instanceof CSSKeyframeRule)
              .slice(0, 60)
              .map((step) => `${step.keyText}{${safeDeclarations(step.style)}}`)
              .join('')}}`;
          if (rule instanceof CSSMediaRule)
            return `@media ${rule.conditionText}{${rules(rule.cssRules, depth + 1)}}`;
          return '';
        })
        .join('\n');
    };
    return rules(sheet.cssRules);
  } catch {
    return '';
  }
}
