import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const action = args[0] ?? 'report';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const refExists = (ref) => {
  try { execFileSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root }); return true; }
  catch { return false; }
};
if (action === 'report') {
  const unreachable = git('fsck', '--no-reflogs', '--unreachable', '--no-progress').split('\n').filter((line) => line.includes('unreachable commit'));
  console.log(JSON.stringify({
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current') || '(detached)',
    dirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean).length,
    stashes: git('stash', 'list').split('\n').filter(Boolean),
    worktrees: git('worktree', 'list', '--porcelain').split('\n').filter(Boolean),
    branches: git('for-each-ref', '--format=%(refname:short) %(objectname:short) %(upstream:short)', 'refs/heads', 'refs/remotes/origin').split('\n').filter(Boolean),
    unreachableCommits: unreachable,
  }, null, 2));
} else if (action === 'bundle') {
  const dir = `${root}/.calledit-backups`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${dir}/calledit-${stamp}.bundle`;
  execFileSync('git', ['bundle', 'create', path, '--all'], { cwd: root, stdio: 'inherit' });
  console.log(JSON.stringify({ path, bytes: statSync(path).size, includesDirtyFiles: false }, null, 2));
} else if (action === 'preserve') {
  const commit = args[1];
  const branch = args[2];
  if (!commit || !branch?.startsWith('codex/recovered-')) throw new Error('Usage: pnpm recovery -- preserve <commit> codex/recovered-<name>');
  git('cat-file', '-e', `${commit}^{commit}`);
  if (refExists(`refs/heads/${branch}`)) throw new Error(`Branch already exists: ${branch}`);
  git('branch', branch, commit);
  console.log(JSON.stringify({ preserved: commit, branch }, null, 2));
} else {
  throw new Error('Usage: pnpm recovery -- <report|bundle|preserve>');
}
