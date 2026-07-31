import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const sanitizeTraktSettings = async (settingsPath) => {
  if (!path.isAbsolute(settingsPath)) {
    throw new Error('settings file must use an absolute path');
  }

  const serializedSettings = await readFile(settingsPath, 'utf8');
  let settings;
  try {
    settings = JSON.parse(serializedSettings);
  } catch {
    throw new Error('settings JSON is invalid');
  }
  const result = Object.hasOwn(settings, 'trakt')
    ? 'removed'
    : 'already_absent';
  delete settings.trakt;

  const temporaryPath = path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.sanitize-${process.pid}-${randomUUID()}`
  );
  const temporaryFile = await open(temporaryPath, 'wx', 0o600);

  try {
    await temporaryFile.writeFile(
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf8'
    );
    await temporaryFile.sync();
  } finally {
    await temporaryFile.close();
  }

  await rename(temporaryPath, settingsPath);
  return result;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.length !== 3) {
    console.error('usage: sanitize-trakt-settings.mjs SETTINGS_JSON_COPY');
    process.exitCode = 1;
  } else {
    try {
      console.log(await sanitizeTraktSettings(process.argv[2]));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
