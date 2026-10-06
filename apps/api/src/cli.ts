import readline from 'node:readline';
import { Writable } from 'node:stream';
import {
  loadConfig, createPool, waitForDb, runMigrations, createBoss, Keyring, requireSecret, AuthService, CredentialService, VaultService,
  validatePasswordPolicy, log, BackupService,
} from '@sb/core';
import path from 'node:path';

/**
 * Operator CLI, run inside the api container:
 *   migrate                 apply DB migrations + queue schema (one-shot service)
 *   create-admin            interactive first-owner creation (no default account exists)
 *   reset-password          interactive password reset for an existing user (revokes sessions)
 *   rotate-credentials      re-encrypt secrets with the active master-key version
 * Passwords are read from the TTY with echo off, or from stdin with --password-stdin. Never argv.
 */
const muted = new Writable({ write(_c, _e, cb) { cb(); } });

async function ask(q: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY && !hidden) {
    // Non-interactive: read one line from stdin.
  }
  const rl = readline.createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: !!process.stdin.isTTY });
  if (hidden) process.stdout.write(q);
  const ans = await new Promise<string>(r => rl.question(hidden ? '' : q, a => r(a)));
  rl.close();
  if (hidden) process.stdout.write('\n');
  return ans.trim();
}

async function stdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const db = createPool(cfg.databaseUrl, 3);
  await waitForDb(db, { attempts: 60 });
  try {
    if (cmd === 'migrate') {
      const r = await runMigrations(db);
      const boss = await createBoss(cfg.databaseUrl, 'migrate');
      await boss.stop({ graceful: false });
      console.log(JSON.stringify({ ok: true, applied: r.applied, schema: r.current }));
      return;
    }
    const ring = Keyring.parse(requireSecret('MASTER_KEY'));
    const auth = new AuthService(db, () => ring);
    if (cmd === 'create-admin') {
      const owners = (await db.query('SELECT count(*)::int n FROM users WHERE is_installation_owner')).rows[0].n;
      if (owners) { console.error('An owner already exists. Use reset-password to recover access.'); process.exitCode = 2; return; }
      let email: string, name: string, pw: string, wsName: string, slug: string;
      if (process.argv.includes('--password-stdin')) {
        email = arg('email') ?? ''; name = arg('name') ?? 'Owner'; wsName = arg('workspace-name') ?? 'فضای شخصی'; slug = arg('workspace-slug') ?? 'personal';
        pw = (await stdinLines())[0] ?? '';
      } else {
        email = await ask('Owner email: ');
        name = (await ask('Display name: ')) || 'Owner';
        pw = await ask(`Password (min 12 chars, hidden): `, true);
        const pw2 = await ask('Repeat password: ', true);
        if (pw !== pw2) { console.error('Passwords do not match.'); process.exitCode = 1; return; }
        wsName = (await ask('Workspace name [فضای شخصی]: ')) || 'فضای شخصی';
        slug = (await ask('Workspace folder slug [personal]: ')) || 'personal';
      }
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) { console.error('Invalid email.'); process.exitCode = 1; return; }
      try { validatePasswordPolicy(pw); } catch (e) { console.error((e as Error).message); process.exitCode = 1; return; }
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) { console.error('Slug must be lowercase letters, digits and dashes.'); process.exitCode = 1; return; }
      const r = await auth.createOwner(email, name, pw, { slug, name: wsName });
      await new VaultService(db, cfg.vaultRoot, process.env.VAULT_TEMPLATE_DIR).initWorkspace(r.workspaceId, slug);
      console.log(`Owner created: ${email}. Workspace "${wsName}" initialised at vault/${slug}/. Sign in at ${cfg.appOrigin}/login`);
      return;
    }
    if (cmd === 'reset-password') {
      const email = (arg('email') ?? (await ask('User email: '))).toLowerCase();
      const u = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
      if (!u) { console.error('No such user.'); process.exitCode = 1; return; }
      const pw = process.argv.includes('--password-stdin') ? (await stdinLines())[0] ?? '' : await ask('New password (hidden): ', true);
      if (!process.argv.includes('--password-stdin') && pw !== (await ask('Repeat: ', true))) { console.error('Passwords do not match.'); process.exitCode = 1; return; }
      await auth.setPassword(u.id, pw);
      if (process.argv.includes('--disable-totp')) await auth.disableTotp(u.id);
      console.log('Password reset. All sessions of this user were revoked.');
      return;
    }
    if (cmd === 'rotate-credentials') {
      const r = await new CredentialService(db, () => ring).rotateToActiveKey();
      console.log(JSON.stringify({ ok: true, active: ring.active, reencrypted: r }));
      return;
    }
    if (cmd === 'backup' || cmd === 'verify-backup' || cmd === 'restore') {
      const svc = new BackupService(db, { vault: cfg.vaultRoot, sources: cfg.sourcesRoot, backups: cfg.backupRoot }, cfg.appVersion, process.env.UPSTREAM_COMMIT ?? null);
      const pass = process.argv.includes('--passphrase-stdin') ? ((await stdinLines())[0] ?? '') : undefined;
      if (cmd === 'backup') {
        const r = await svc.create({ passphrase: pass });
        console.log(JSON.stringify({ ok: true, file: path.basename(r.file), tables: Object.keys(r.manifest.tables).length, files: r.manifest.files.length, activeRuns: r.manifest.activeRuns, notes: r.manifest.notes }));
        return;
      }
      const name = arg('file');
      if (!name || !/^sb-backup-[0-9TZ-]+\.zip(\.enc)?$/.test(path.basename(name))) { console.error('--file <sb-backup-....zip> required'); process.exitCode = 64; return; }
      const file = path.isAbsolute(name) ? name : path.join(cfg.backupRoot, path.basename(name));
      const v = await svc.verify(file, pass);
      console.log(JSON.stringify({ ok: v.ok, problems: v.problems, manifest: { createdAt: v.manifest.createdAt, schemaVersion: v.manifest.schemaVersion, appVersion: v.manifest.appVersion, files: v.manifest.files, activeRuns: v.manifest.activeRuns, tables: Object.fromEntries(Object.entries(v.manifest.tables).map(([k, x]) => [k, x.rows])) } }, null, 1));
      if (cmd === 'verify-backup') { process.exitCode = v.ok ? 0 : 3; return; }
      if (!v.ok) { console.error('Refusing to restore an invalid backup.'); process.exitCode = 3; return; }
      if (arg('confirm') !== path.basename(file)) { console.error(`Dry-run only. To restore, re-run with --confirm ${path.basename(file)} (current data is moved to .pre-restore-*, sessions end, schedules pause).`); process.exitCode = 4; return; }
      const r = await svc.restore(file, pass);
      console.log(JSON.stringify({ ok: true, restored: r.restored }));
      return;
    }
    console.error('usage: cli.js migrate | create-admin | reset-password [--email x] | rotate-credentials');
    process.exitCode = 64;
  } finally { await db.end(); }
}

main().catch(e => { log.error('cli.failed', { error: (e as Error).message }); console.error((e as Error).message); process.exit(1); });
