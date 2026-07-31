import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helperPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sanitize-trakt-settings.mjs'
);
const helperUrl = new URL('./sanitize-trakt-settings.mjs', import.meta.url);

const fixture = {
  main: {
    applicationTitle: 'Seerr',
    nested: { trakt: 'preserve nested value' },
  },
  trakt: {
    clientId: 'fixture-trakt-client-id',
    clientSecret: 'fixture-trakt-client-secret',
  },
  notifications: { agents: [] },
};

const loadSanitizeTraktSettings = async () => {
  try {
    const module = await import(helperUrl);
    return module.sanitizeTraktSettings;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
};

let fixtureRoot;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'seerr-settings-sanitize-'));
});

after(async () => {
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('removes only the top-level Trakt settings without exposing secrets', async () => {
  const sanitizeTraktSettings = await loadSanitizeTraktSettings();
  assert.equal(
    typeof sanitizeTraktSettings,
    'function',
    'sanitizeTraktSettings must exist'
  );
  const settingsPath = path.join(fixtureRoot, 'settings.json');
  await writeFile(settingsPath, `${JSON.stringify(fixture, null, 2)}\n`, {
    mode: 0o644,
  });
  const expected = structuredClone(fixture);
  delete expected.trakt;

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    helperPath,
    settingsPath,
  ]);
  const serialized = await readFile(settingsPath, 'utf8');
  const sanitized = JSON.parse(serialized);

  assert.deepEqual(sanitized, expected);
  assert.equal(stdout.trim(), 'removed');
  assert.equal(stderr, '');
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  for (const secret of [fixture.trakt.clientId, fixture.trakt.clientSecret]) {
    assert.equal(stdout.includes(secret), false);
    assert.equal(stderr.includes(secret), false);
    assert.equal(serialized.includes(secret), false);
  }
});

test('reports when top-level Trakt settings are already absent', async () => {
  const sanitizeTraktSettings = await loadSanitizeTraktSettings();
  assert.equal(
    typeof sanitizeTraktSettings,
    'function',
    'sanitizeTraktSettings must exist'
  );
  const settingsPath = path.join(fixtureRoot, 'already-absent.json');
  const settings = { main: { applicationTitle: 'Seerr' } };
  await writeFile(settingsPath, JSON.stringify(settings));

  const result = await sanitizeTraktSettings(settingsPath);

  assert.equal(result, 'already_absent');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test('rejects malformed settings with a content-free CLI error and no rewrite', async () => {
  const settingsPath = path.join(fixtureRoot, 'malformed-settings.json');
  const secretLikeValue = 'trakt-secret-like-value-that-must-not-leak';
  const malformed = `{"trakt":{"clientSecret":"${secretLikeValue}"`;
  await writeFile(settingsPath, malformed, { mode: 0o640 });

  await assert.rejects(
    execFileAsync(process.execPath, [helperPath, settingsPath]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, 'settings JSON is invalid\n');
      assert.equal(error.stdout.includes(secretLikeValue), false);
      assert.equal(error.stderr.includes(secretLikeValue), false);
      return true;
    }
  );
  assert.equal(await readFile(settingsPath, 'utf8'), malformed);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o640);
});

test('rejects a relative settings path', async () => {
  const sanitizeTraktSettings = await loadSanitizeTraktSettings();
  assert.equal(
    typeof sanitizeTraktSettings,
    'function',
    'sanitizeTraktSettings must exist'
  );
  await assert.rejects(sanitizeTraktSettings('settings.json'), /absolute path/);
});
