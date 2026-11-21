// Production start-up script for Render: `node prisma/setup.mjs`.
// 1. Applies pending migrations (`prisma migrate deploy`) so a fresh database
//    gets its tables before anything else runs. This step must fail loudly
//    and stop the process: the server must never start against a database
//    that is missing tables.
// 2. Creates the first platform owner from ADMIN_EMAIL/ADMIN_PHONE,
//    ADMIN_PASSWORD, ADMIN_NAME if one does not already exist (delegates to
//    `admin-create.mjs`, which is itself idempotent and safe to run on every
//    deploy). Missing or invalid admin variables are logged and skipped
//    rather than blocking the server from starting.
// 3. Starts the server (`node dist/main`), forwarding its exit code and
//    signals so Render's process management works as expected.
import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] setup: ${message}`);
}

function maskUrl(url) {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(set, unparsable)';
  }
}

log(`node ${process.version}, cwd ${process.cwd()}, platform ${process.platform}`);
log(`NODE_ENV=${process.env.NODE_ENV ?? '(not set)'}`);
log(`DATABASE_URL=${maskUrl(process.env.DATABASE_URL)}`);
log(`DIRECT_URL=${maskUrl(process.env.DIRECT_URL)}`);

const prismaCliPresent = existsSync('node_modules/.bin/prisma');
log(`local prisma CLI present at node_modules/.bin/prisma: ${prismaCliPresent}`);
log(`dist/main.js present: ${existsSync('dist/main.js')}`);

function run(label, command, args) {
  log(`${label}: running "${command} ${args.join(' ')}"...`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`[${timestamp()}] setup: ${label} failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(
      `[${timestamp()}] setup: ${label} exited with code ${String(result.status)}${
        result.signal ? ` (signal ${result.signal})` : ''
      }`,
    );
    return false;
  }
  log(`${label}: done.`);
  return true;
}

if (!process.env.DATABASE_URL && !process.env.DIRECT_URL) {
  console.error(
    `[${timestamp()}] setup: neither DATABASE_URL nor DIRECT_URL is set; refusing to start. ` +
      'Set DATABASE_URL (and, for a pooled connection, DIRECT_URL) in the Render service\'s environment variables.',
  );
  process.exit(1);
}

if (!prismaCliPresent) {
  console.error(
    `[${timestamp()}] setup: node_modules/.bin/prisma is missing. "prisma" must be installed ` +
      '(it is a "dependencies" entry in package.json) so it is present after a production install; ' +
      'refusing to fall back to "npx", which could silently fetch an unpinned prisma version from the network.',
  );
  process.exit(1);
}

// `--no-install` stops npx from ever fetching prisma from the registry: if the
// local CLI is somehow gone despite the check above, this fails loudly instead
// of running a different, unpinned prisma version.
if (!run('applying migrations', 'npx', ['--no-install', 'prisma', 'migrate', 'deploy'])) {
  process.exit(1);
}

const hasAdminContact = Boolean(process.env.ADMIN_EMAIL || process.env.ADMIN_PHONE);
const hasAdminPassword = Boolean(process.env.ADMIN_PASSWORD);
if (hasAdminContact && hasAdminPassword) {
  run('creating platform owner (skips if one already exists)', 'node', ['prisma/admin-create.mjs']);
} else {
  log('ADMIN_EMAIL/ADMIN_PHONE or ADMIN_PASSWORD not set, skipping admin creation.');
}

log('starting server...');
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
