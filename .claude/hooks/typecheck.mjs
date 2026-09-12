// PostToolUse hook: after Edit/Write of a TypeScript file, run `tsc --noEmit` on the project.
// On type errors it exits 2 so the (truncated) errors are shown to the agent as feedback.
// Silent (exit 0) for non-TS files and until Phase 0 has installed TypeScript.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const file = String(input?.tool_input?.file_path ?? '');
if (!/\.[cm]?ts$/.test(file)) process.exit(0);

const root = input.cwd || process.cwd();
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(path.join(root, 'tsconfig.json')) || !existsSync(tscBin)) process.exit(0);

const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
});
if (result.status === 0) process.exit(0);

const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/);
const shown = lines.slice(0, 40).join('\n');
const more = lines.length > 40 ? `\n… ${lines.length - 40} more lines; run npm run typecheck` : '';
process.stderr.write(`tsc --noEmit failed after editing ${path.relative(root, file) || file}:\n${shown}${more}\n`);
process.exit(2);
