export type PreviewAction = {
  kind: 'section' | 'card' | 'speak' | 'info' | 'advance' | 'resetStages' | 'answer' | 'resetQuiz';
  args: string[];
};

/** Interpret only supported event signatures; never evaluate artifact code. */
export function previewAction(value: string): PreviewAction | undefined {
  if (value.length > 4096 || /[\\\r\n\0]/.test(value)) return;
  const match = /^(event\.stopPropagation\(\)\s*;\s*)?([A-Za-z]+)\((.*)\)\s*;?$/.exec(value.trim());
  if (!match || (match[1] && match[2] !== 'speak')) return;
  const args: { text: string; literal: boolean }[] = [];
  let input = match[3].trim();
  while (input) {
    const arg = /^(?:'([^']*)'|"([^"]*)"|(this))\s*(,\s*|$)/.exec(input);
    if (!arg || args.length >= 2 || (arg[4] && arg[0].length === input.length)) return;
    args.push({ text: arg[1] ?? arg[2] ?? '', literal: !arg[3] });
    input = input.slice(arg[0].length);
  }
  const literal = (i: number, max: number) =>
    args[i]?.literal && args[i].text.length > 0 && args[i].text.length <= max;
  const text = args.map((arg) => arg.text);
  switch (match[2]) {
    case 'showSection':
      if (args.length === 1 && literal(0, 80) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(text[0]))
        return { kind: 'section', args: text };
      break;
    case 'toggleCard':
      if (args.length === 1 && !args[0].literal) return { kind: 'card', args: [] };
      break;
    case 'speak':
      if (args.length === 1 && literal(0, 2000)) return { kind: 'speak', args: text };
      break;
    case 'showInfo':
      if (args.length === 2 && literal(0, 128) && literal(1, 2000))
        return { kind: 'info', args: text };
      break;
    case 'checkAns':
      if (args.length === 2 && !args[0].literal && literal(1, 16))
        return { kind: 'answer', args: [text[1]] };
      break;
    case 'playDivisionAnim':
      if (!args.length) return { kind: 'advance', args: [] };
      break;
    case 'resetDivisionAnim':
      if (!args.length) return { kind: 'resetStages', args: [] };
      break;
    case 'resetQuiz':
      if (!args.length) return { kind: 'resetQuiz', args: [] };
      break;
  }
}

export function bindPreviewAction(element: Element, action: PreviewAction) {
  element.setAttribute('data-ob-action', action.kind);
  element.setAttribute('data-ob-args', JSON.stringify(action.args));
  if (element.localName !== 'button') {
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
  }
  if (action.kind === 'card') element.setAttribute('aria-expanded', 'false');
  if (action.kind === 'info') element.setAttribute('aria-label', action.args[0]);
}
