import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprintFixture,
  formatSecretFindings,
  scanNarrativeSecrets,
} from './check-narrative-secrets';

const temporaryRoots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'cheonmu-secret-scan-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'admin', 'dist'), { recursive: true });
  return root;
}

function serviceRoleJwt(): string {
  const encode = (value: string) => Buffer.from(value).toString('base64url');
  return `${encode('{"alg":"HS256","typ":"JWT"}')}.${encode('{"role":"service_role","sub":"fixture"}')}.${'s'.repeat(43)}`;
}

function providerKey(suffix = 'A'): string {
  return ['s', 'k', '-', suffix.repeat(32)].join('');
}

function githubToken(suffix = 'B'): string {
  return ['gh', 'p_', suffix.repeat(36)].join('');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('scanNarrativeSecrets', () => {
  it('reports each leak by repository-relative file and rule without returning or formatting the matched value', async () => {
    // Removing a rule, returning match text, or echoing a credential in the report breaks this boundary.
    const root = repository();
    const jwt = serviceRoleJwt();
    const provider = providerKey();
    const github = githubToken();
    const authorizationCredential = ['Az9_', 'cDe7-'].join('').repeat(6);
    const authorization = ['Authorization: Bearer ', authorizationCredential].join('');
    const promptField = JSON.stringify({ [['raw', 'Prompt'].join('')]: 'private fixture instruction' });
    const fixtures = new Map([
      ['src/service.txt', jwt],
      ['src/provider.txt', provider],
      ['src/github.txt', github],
      ['src/authorization.txt', authorization],
      ['src/prompt.json', promptField],
    ]);
    for (const [path, source] of fixtures) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), source);
    }

    const findings = await scanNarrativeSecrets({ repoRoot: root, trackedFiles: [...fixtures.keys()] });

    expect(findings).toEqual([
      { file: 'src/authorization.txt', rule: 'authorization-header' },
      { file: 'src/github.txt', rule: 'github-token' },
      { file: 'src/prompt.json', rule: 'raw-prompt-field' },
      { file: 'src/provider.txt', rule: 'provider-key' },
      { file: 'src/service.txt', rule: 'service-role-jwt' },
    ]);
    const report = formatSecretFindings(findings);
    for (const secret of [jwt, provider, github, authorization, 'private fixture instruction']) {
      expect(JSON.stringify(findings)).not.toContain(secret);
      expect(report).not.toContain(secret);
    }
  });

  it('scans root and admin build outputs in addition to tracked source', async () => {
    // Dropping either build directory lets bundled credentials bypass the tracked-source gate.
    const root = repository();
    writeFileSync(join(root, 'tracked.js'), providerKey('D'));
    writeFileSync(join(root, 'dist', 'bundle.js'), githubToken('E'));
    writeFileSync(join(root, 'admin', 'dist', 'admin.js'), serviceRoleJwt());

    const findings = await scanNarrativeSecrets({ repoRoot: root, trackedFiles: ['tracked.js'] });

    expect(findings).toEqual([
      { file: 'admin/dist/admin.js', rule: 'service-role-jwt' },
      { file: 'dist/bundle.js', rule: 'github-token' },
      { file: 'tracked.js', rule: 'provider-key' },
    ]);
  });

  it('detects case and common encodings while ignoring source templates and obvious placeholders', async () => {
    // A case-only or percent/base64 encoding change must not make a real credential invisible.
    const root = repository();
    const upperProvider = providerKey('F').replace(/^sk-/, 'SK-');
    const encodedGitHub = [...githubToken('G')].map((character) => `%${character.charCodeAt(0).toString(16)}`).join('');
    const encodedCredential = ['Hx8_', 'mNo6-'].join('').repeat(6);
    const encodedAuthorization = Buffer.from(['authorization: bearer ', encodedCredential].join('')).toString('base64');
    writeFileSync(join(root, 'encoded.txt'), [upperProvider, encodedGitHub, encodedAuthorization].join('\n'));
    writeFileSync(join(root, 'placeholders.txt'), [
      'authorization: `Bearer ${token}`',
      'Authorization: Bearer token',
      'sk-example-not-a-real-key',
      ['Authorization: Bearer ', ['s', 'k', '-example-not-a-real-key'].join('')].join(''),
      'ghp_...',
      'rawPrompt: undefined',
      'fixture-github-token',
    ].join('\n'));

    const findings = await scanNarrativeSecrets({ repoRoot: root, trackedFiles: ['encoded.txt', 'placeholders.txt'] });

    expect(findings).toEqual([
      { file: 'encoded.txt', rule: 'authorization-header' },
      { file: 'encoded.txt', rule: 'github-token' },
      { file: 'encoded.txt', rule: 'provider-key' },
    ]);
  });

  it('detects quoted authorization keys, opaque bearer values, mixed percent text, and multiline prompt literals', async () => {
    // JSON quoting, low-variety opaque credentials, or an unrelated malformed percent must not hide a leak.
    const root = repository();
    const opaqueCredential = 'Q'.repeat(32);
    const jsonAuthorization = JSON.stringify({ [['Author', 'ization'].join('')]: ['Bearer ', opaqueCredential].join('') });
    const encodedGitHub = [...githubToken('H')].map((character) => `%${character.charCodeAt(0).toString(16)}`).join('');
    const promptKey = ['raw', 'Prompt'].join('');
    const multilinePrompt = [promptKey, ': `private fixture line one\nline two`'].join('');
    const longPrompt = [promptKey, ': "', 'private fixture '.repeat(400), '"'].join('');
    writeFileSync(join(root, 'quoted.json'), jsonAuthorization);
    writeFileSync(join(root, 'mixed-percent.txt'), `progress is 100%\n${encodedGitHub}`);
    writeFileSync(join(root, 'multiline.ts'), multilinePrompt);
    writeFileSync(join(root, 'long-prompt.ts'), longPrompt);

    const findings = await scanNarrativeSecrets({
      repoRoot: root,
      trackedFiles: ['quoted.json', 'mixed-percent.txt', 'multiline.ts', 'long-prompt.ts'],
    });

    expect(findings).toEqual([
      { file: 'long-prompt.ts', rule: 'raw-prompt-field' },
      { file: 'mixed-percent.txt', rule: 'github-token' },
      { file: 'multiline.ts', rule: 'raw-prompt-field' },
      { file: 'quoted.json', rule: 'authorization-header' },
    ]);
    expect(formatSecretFindings(findings)).not.toContain(opaqueCredential);
  });

  it('allows only the exact fixture value whose SHA-256 fingerprint is listed', async () => {
    // File- or rule-wide exemptions would hide a second secret placed beside an allowed fixture.
    const root = repository();
    const allowed = providerKey('J');
    const unexpected = providerKey('K');
    writeFileSync(join(root, 'fixtures.txt'), `${allowed}\n${unexpected}`);

    const findings = await scanNarrativeSecrets({
      repoRoot: root,
      trackedFiles: ['fixtures.txt'],
      allowedFixtureHashes: new Set([fingerprintFixture(allowed)]),
    });

    expect(findings).toEqual([{ file: 'fixtures.txt', rule: 'provider-key' }]);
  });

  it('fails closed before reading a tracked path or build symlink that resolves outside the repository', async () => {
    // Following ../ or an external symlink could leak unrelated machine secrets into scanner output/state.
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), 'cheonmu-secret-outside-'));
    temporaryRoots.push(outside);
    writeFileSync(join(outside, 'outside.txt'), providerKey('L'));

    await expect(scanNarrativeSecrets({ repoRoot: root, trackedFiles: ['../outside.txt'] }))
      .rejects.toThrow('scan_path_outside_repository');

    const linked = join(root, 'dist', 'external');
    try {
      symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await expect(scanNarrativeSecrets({ repoRoot: root, trackedFiles: [] }))
      .rejects.toThrow('scan_path_outside_repository');
  });

  it('follows an in-repository build junction instead of silently skipping its files', async () => {
    // Build tools may materialize an in-repo junction; its physical target still belongs to the scan scope.
    const root = repository();
    const target = join(root, 'generated-bundles');
    mkdirSync(target);
    writeFileSync(join(target, 'bundle.js'), providerKey('M'));
    const linked = join(root, 'dist', 'internal');
    try {
      symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    const findings = await scanNarrativeSecrets({ repoRoot: root, trackedFiles: [] });

    expect(findings).toEqual([{ file: 'generated-bundles/bundle.js', rule: 'provider-key' }]);
  });
});
