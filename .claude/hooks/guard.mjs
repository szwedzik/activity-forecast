// PreToolUse guard for shell commands (Bash and PowerShell tools).
// Exit 2 blocks the call; the message on stderr is shown to the agent.
// Anything else exits 0 and the normal permission flow continues.
//
// Why: these three actions are decisions the user makes, not side effects of coding.
//   1. adding a dependency         -> AGENTS.md: declare it in package.json, log it in docs/DECISIONS.md
//   2. git commit --no-verify      -> the pre-commit check is the "no red commits" rule
//   3. git push --force            -> the commit history is part of the deliverable
import { readFileSync } from 'node:fs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const command = String(input?.tool_input?.command ?? '');
if (!command) process.exit(0);

// Split on shell separators so each simple command is checked on its own.
const parts = command.split(/&&|\|\||;|\||\r?\n/).map((p) => p.trim()).filter(Boolean);

function addsDependency(part) {
  const m = part.match(/^(?:npx\s+)?(npm|pnpm|yarn|bun)\s+(install|i|add|isntall)\b(.*)$/);
  if (!m) return false;
  const positional = m[3].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  return positional.length > 0; // bare `npm install` / `npm i` / `npm ci` are fine
}
const bypassesPreCommit = (part) => /^git\s+commit\b/.test(part) && /(^|\s)(--no-verify|-n)(\s|$)/.test(part);
const forcePushes = (part) => /^git\s+push\b/.test(part) && /(^|\s)(--force|-f|--force-with-lease)(\s|$)/.test(part);

const reasons = [];
for (const part of parts) {
  if (addsDependency(part)) {
    reasons.push(
      `"${part}" adds a dependency. Adding one is a decision, not a side effect: ask the user, then declare it in package.json and log it in docs/DECISIONS.md (see AGENTS.md). A bare "npm install" is allowed.`,
    );
  }
  if (bypassesPreCommit(part)) {
    reasons.push(`"${part}" bypasses the pre-commit check. Fix the failing check instead (AGENTS.md: never commit red).`);
  }
  if (forcePushes(part)) {
    reasons.push(`"${part}" rewrites remote history, which the reviewers are asked to read. Ask the user.`);
  }
}

if (reasons.length > 0) {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs:\n- ${reasons.join('\n- ')}\n`);
  process.exit(2);
}
process.exit(0);
