import { extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const postcss = require('postcss');
const han = /[\u3400-\u9fff]/u;

/** Inspect comment tokens rather than Chinese product copy or test data. */
export function nonEnglishComments(file) {
  const result = [],
    seen = new Set();
  const add = (position, text) => {
    if (!han.test(text) || seen.has(position)) return;
    seen.add(position);
    result.push({
      line: file.text.slice(0, position).split('\n').length,
      message: 'Use English for source comments.',
    });
  };
  const extension = extname(file.path);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      for (const range of [
        ...(ts.getLeadingCommentRanges(file.text, node.getFullStart()) || []),
        ...(ts.getTrailingCommentRanges(file.text, node.end) || []),
      ])
        add(range.pos, file.text.slice(range.pos, range.end));
      for (const child of node.getChildren(source)) visit(child);
    }
    visit(source);
  } else if (extension === '.css') {
    postcss
      .parse(file.text, { from: file.path })
      .walkComments((comment) => add(comment.source.start.offset, comment.text));
  } else if (extension === '.html') {
    for (const match of file.text.matchAll(/<!--[\s\S]*?-->/g)) add(match.index, match[0]);
  } else if (['.rs', '.swift', '.dart', '.kt', '.java'].includes(extension)) {
    // Consume quoted data before comment tokens, including raw and multiline strings.
    const tokens =
      /r(#+)?"[\s\S]*?"\1|r?"""[\s\S]*?"""|r?'''[\s\S]*?'''|r"[^"]*"|r'[^']*'|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
    for (const token of file.text.matchAll(tokens))
      if (token[0].startsWith('//') || token[0].startsWith('/*')) add(token.index, token[0]);
  }
  return result;
}

/** Python uses its own tokenizer so hashes inside strings stay ordinary data. */
export const pythonCommentScanner = `
import io,json,sys,tokenize
items=json.load(sys.stdin)
output=[]
for item in items:
    for token in tokenize.generate_tokens(io.StringIO(item['text']).readline):
        if token.type==tokenize.COMMENT and any('\\u3400'<=char<='\\u9fff' for char in token.string):
            output.append({'path':item['path'],'line':token.start[0],'message':'Use English for source comments.'})
json.dump(output,sys.stdout)
`;
