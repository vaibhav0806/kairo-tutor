import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../scripts/invite-prod.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runInvite(...args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'kairo-invite-prod-'));
  temporaryDirectories.push(directory);
  const marker = join(directory, 'injected');
  const capture = join(directory, 'docker-args');
  const ssh = join(directory, 'ssh');
  const docker = join(directory, 'docker');
  const sshKey = join(directory, 'unused-key');

  writeFileSync(
    ssh,
    `#!/usr/bin/env bash
remote_command="\${!#}"
bash -c "\${remote_command}"
`,
  );
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$DOCKER_CAPTURE"
echo captured
`,
  );
  writeFileSync(sshKey, 'test fixture');
  chmodSync(ssh, 0o755);
  chmodSync(docker, 0o755);

  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      DOCKER_CAPTURE: capture,
      KAIRO_TEST_MARKER: marker,
      KAIRO_RELEASE_HOST: 'test@example.invalid',
      KAIRO_RELEASE_SSH_KEY: sshKey,
      KAIRO_CONTAINER: 'kairo-server',
    },
  });

  const dockerArgs = result.status === 0
    ? readFileSync(capture).toString().split('\0').filter(Boolean)
    : [];

  return { directory, dockerArgs, marker, result };
}

describe('production invite script', () => {
  it('transports multiple email arguments without changing them', () => {
    const { dockerArgs, result } = runInvite(
      'add',
      'First.Person+tag@example.com',
      'second@example.org',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(dockerArgs).toContain('KAIRO_INVITE_CMD=add');
    const encodedEmails = dockerArgs
      .find((argument) => argument.startsWith('KAIRO_INVITE_EMAILS_B64='))
      ?.slice('KAIRO_INVITE_EMAILS_B64='.length);
    expect(Buffer.from(encodedEmails ?? '', 'base64').toString()).toBe(
      'First.Person+tag@example.com\0second@example.org\0',
    );
  });

  it('preserves list and remove commands', () => {
    const listed = runInvite('list');
    const removed = runInvite('remove', 'one@example.com', 'two@example.org');

    expect(listed.result.status, listed.result.stderr).toBe(0);
    expect(listed.dockerArgs).toContain('KAIRO_INVITE_CMD=list');
    expect(listed.dockerArgs).toContain('KAIRO_INVITE_EMAILS_B64=');
    expect(removed.result.status, removed.result.stderr).toBe(0);
    expect(removed.dockerArgs).toContain('KAIRO_INVITE_CMD=remove');
    const encodedEmails = removed.dockerArgs
      .find((argument) => argument.startsWith('KAIRO_INVITE_EMAILS_B64='))
      ?.slice('KAIRO_INVITE_EMAILS_B64='.length);
    expect(Buffer.from(encodedEmails ?? '', 'base64').toString()).toBe(
      'one@example.com\0two@example.org\0',
    );
  });

  it('does not execute shell syntax from an email argument', () => {
    const payload = `bad@example.com'; touch "$KAIRO_TEST_MARKER"; #`;
    const { dockerArgs, marker, result } = runInvite('add', payload);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(dockerArgs.join(' ')).not.toContain(payload);
    const encodedEmails = dockerArgs
      .find((argument) => argument.startsWith('KAIRO_INVITE_EMAILS_B64='))
      ?.slice('KAIRO_INVITE_EMAILS_B64='.length);
    expect(Buffer.from(encodedEmails ?? '', 'base64').toString()).toBe(`${payload}\0`);
  });
});
