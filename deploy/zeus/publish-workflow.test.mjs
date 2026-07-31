import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/workflows/publish-zeus-image.yml'
);

const readWorkflow = async () =>
  yaml.load(await readFile(workflowPath, 'utf8'));

test('publishes only the household branch with least-privilege permissions', async () => {
  const workflow = await readWorkflow();

  assert.deepEqual(workflow.on, {
    push: { branches: ['codex/trakt-household'] },
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: 'read',
    packages: 'write',
  });
});

test('pins every action and publishes one provenance-free amd64 image', async () => {
  const workflow = await readWorkflow();
  const steps = workflow.jobs.publish.steps;

  for (const step of steps.filter(({ uses }) => uses)) {
    assert.match(
      step.uses,
      /^[^@\s]+@[0-9a-f]{40}$/,
      `${step.name} must pin an action commit`
    );
  }

  const login = steps.find(
    ({ name }) => name === 'Log in to GitHub Container Registry'
  );
  assert.deepEqual(login.with, {
    registry: 'ghcr.io',
    username: '${{ github.repository_owner }}',
    password: '${{ secrets.GITHUB_TOKEN }}',
  });

  const build = steps.find(({ name }) => name === 'Build and push');
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.push, true);
  assert.equal(build.with.tags, 'ghcr.io/crovlune/seerr:3.4.1-trakt.1');
  assert.equal(build.with.provenance, false);
  assert.match(build.with['build-args'], /COMMIT_TAG=\$\{\{ github\.sha \}\}/);
  assert.match(
    build.with['build-args'],
    /SOURCE_DATE_EPOCH=\$\{\{ steps\.commit\.outputs\.timestamp \}\}/
  );
});
