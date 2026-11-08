import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceFiles } from './policy/files.mjs';
import { nonEnglishComments, pythonCommentScanner } from './policy/comments.mjs';
import { smallFonts } from './policy/fonts.mjs';

const files = await sourceFiles(resolve(import.meta.dirname, '../..'));
const violations = [];
for (const file of files) {
  if (file.lines > 500)
    violations.push({
      path: file.path,
      line: 501,
      rule: 'max-lines',
      message: `${file.lines} lines; maximum 500.`,
    });
  for (const issue of nonEnglishComments(file))
    violations.push({ path: file.path, rule: 'english-comments', ...issue });
  for (const issue of smallFonts(file))
    violations.push({ path: file.path, rule: 'min-font-size', ...issue });
}
const python = files.filter((file) => file.path.endsWith('.py'));
if (python.length) {
  const scan = spawnSync('python3', ['-c', pythonCommentScanner], {
    input: JSON.stringify(python),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (scan.status !== 0) throw new Error(scan.stderr || 'Python comment scan failed.');
  for (const issue of JSON.parse(scan.stdout))
    violations.push({ ...issue, rule: 'english-comments' });
}
const report = { files: files.length, violations, passed: violations.length === 0 };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const issue of violations)
    console.log(`${issue.path}:${issue.line} [${issue.rule}] ${issue.message}`);
  console.log(`${files.length} source files checked; ${violations.length} violations.`);
}
process.exitCode = report.passed ? 0 : 1;
