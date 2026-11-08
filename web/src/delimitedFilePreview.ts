export const TABLE_PREVIEW_LIMIT = { rows: 200, columns: 48, cellLength: 1024 };

export type DelimitedPreview = { rows: string[][]; truncated: boolean };

export function parseDelimitedPreview(
  source: string,
  delimiter: ',' | '\t',
): DelimitedPreview | undefined {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    truncated = false,
    quoted = false,
    closedQuote = false,
    started = false,
    fieldHasValue = false;
  const append = (char: string) => {
    started = true;
    fieldHasValue = true;
    if (row.length >= TABLE_PREVIEW_LIMIT.columns || value.length >= TABLE_PREVIEW_LIMIT.cellLength)
      truncated = true;
    else value += char;
  };
  const field = () => {
    if (row.length < TABLE_PREVIEW_LIMIT.columns) row.push(value);
    else truncated = true;
    value = '';
    fieldHasValue = false;
    closedQuote = false;
  };
  const record = () => {
    field();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') append(char);
      else if (text[i + 1] === '"') {
        append(char);
        i++;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (char === delimiter) {
      field();
      started = true;
    } else if (char === '\r' || char === '\n') {
      record();
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (rows.length === TABLE_PREVIEW_LIMIT.rows && i + 1 < text.length)
        return { rows, truncated: true };
    } else if (closedQuote) return;
    else if (char === '"') {
      if (fieldHasValue) return;
      quoted = true;
      started = true;
    } else append(char);
  }
  if (quoted) return;
  if (started) record();
  return { rows, truncated };
}
