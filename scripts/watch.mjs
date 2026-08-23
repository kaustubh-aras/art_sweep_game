// `devvit playtest` runs one command and expects both bundles to rebuild on
// save, so this fans out into the two vite watchers and keeps their output.
import { spawn } from 'node:child_process';

const targets = [
  ['client', ['vite', 'build', '--watch']],
  ['server', ['vite', 'build', '--watch', '--config', 'vite.server.config.ts']],
];

const children = targets.map(([label, argv]) => {
  const child = spawn('npx', argv, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    // If either watcher dies the playtest is building stale code — take the
    // whole thing down rather than silently shipping half a rebuild.
    console.error(`[watch] ${label} exited with ${code}`);
    shutdown(code ?? 1);
  });
  return child;
});

function shutdown(code) {
  for (const child of children) if (!child.killed) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
