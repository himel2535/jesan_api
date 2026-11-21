// Production start-up script for Render: `node prisma/setup.mjs`.
// 1. Applies pending migrations (`prisma migrate deploy`) so a fresh database
//    gets its tables before anything else runs.
// 2. Creates the first platform owner from ADMIN_EMAIL/ADMIN_PHONE,
//    ADMIN_PASSWORD, ADMIN_NAME if one does not already exist (delegates to
//    `admin-create.mjs`, which is itself idempotent and safe to run on every
//    deploy). Missing or invalid admin variables are logged and skipped
//    rather than blocking the server from starting.
// 3. Starts the server (`node dist/main`), forwarding its exit code and
//    signals so Render's process management works as expected.
import { spawnSync, spawn } from 'node:child_process';

function run(label, command, args) {
  console.log(`setup: ${label}...`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`setup: ${label} failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`setup: ${label} exited with code ${String(result.status)}`);
    return false;
  }
  return true;
}

if (!run('applying migrations', 'npx', ['prisma', 'migrate', 'deploy'])) {
  process.exit(1);
}

const hasAdminContact = Boolean(process.env.ADMIN_EMAIL || process.env.ADMIN_PHONE);
const hasAdminPassword = Boolean(process.env.ADMIN_PASSWORD);
if (hasAdminContact && hasAdminPassword) {
  run('creating platform owner (skips if one already exists)', 'node', ['prisma/admin-create.mjs']);
} else {
  console.log('setup: ADMIN_EMAIL/ADMIN_PHONE or ADMIN_PASSWORD not set, skipping admin creation.');
}

console.log('setup: starting server...');
const server = spawn('node', ['dist/main.js'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.kill(signal);
  });
}
server.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
