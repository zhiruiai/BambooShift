import type { CommandToken } from './composerCommands';

const names = ['招聘助理', 'ai 同事招募员', 'ai同事招募员', 'ai staff recruiter', 'recruiter'];
const boundary = /^[\s@，。！？、：；!?;:,()[\]{}]/u;

/** This shortcut has its own aliases so ordinary @ mentions keep their existing grammar. */
export function recruiterMentionToken(
  text: string,
  caret: number,
  end: number,
): CommandToken | undefined {
  if (caret !== end || caret < 0 || caret > text.length) return;
  const match = text
    .slice(0, caret)
    .match(/(?<![\p{Script=Latin}\p{N}._%+/@-])@([^\r\n@]{1,24})$/u);
  if (!match) return;
  const start = caret - match[1].length - 1;
  const rest = text.slice(start + 1).toLowerCase();
  const query = match[1].toLowerCase();
  const fullName = names.find(
    (name) =>
      name.startsWith(query) &&
      rest.startsWith(name) &&
      (rest.length === name.length || boundary.test(rest.slice(name.length))),
  );
  const suffix = text.slice(caret).match(/^[^\s@，。！？、：；!?;:,()[\]{}]*/u)![0];
  const finish = fullName ? start + fullName.length + 1 : caret + suffix.length;
  const value = text.slice(start, finish);
  if (names.some((name) => name.startsWith(value.slice(1).toLowerCase())))
    return { start, end: finish, value, query };
}
