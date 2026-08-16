import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export type NarrativeSecretRule =
  | 'authorization-header'
  | 'github-token'
  | 'provider-key'
  | 'raw-prompt-field'
  | 'service-role-jwt';

export interface NarrativeSecretFinding {
  file: string;
  rule: NarrativeSecretRule;
}

export interface NarrativeSecretScanOptions {
  repoRoot: string;
  trackedFiles?: readonly string[];
  allowedFixtureHashes?: ReadonlySet<string>;
}

interface RuleMatch {
  rule: NarrativeSecretRule;
  value: string;
}

const providerKeyPattern = /\bsk-(?:ant-|proj-)?[a-z0-9_-]{20,}\b/giu;
const githubTokenPattern = /\b(?:gh[pousr]_[a-z0-9]{30,255}|github_pat_[a-z0-9_]{20,255})\b/giu;
const jwtPattern = /\b([a-z0-9_-]{8,})\.([a-z0-9_-]{8,})\.([a-z0-9_-]{16,})\b/giu;
const authorizationPattern = /(?:["'`]authorization["'`]|\bauthorization\b)\s*[:=]\s*["'`]?bearer[ \t]+([^\s"'`,;}{)\]]{16,})/giu;
const rawPromptPattern = /(?:["'`](?:raw[_-]?prompt|prompt[_-]?(?:text|body|content)|system[_-]?prompt|user[_-]?prompt)["'`]|\b(?:raw[_-]?prompt|prompt[_-]?(?:text|body|content)|system[_-]?prompt|user[_-]?prompt)\b)\s*[:=]\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|`((?:\\[\s\S]|[^`\\])*)`)/giu;
const base64CandidatePattern = /(?:^|[^a-z0-9+/])([a-z0-9+/]{24,8192}={0,2})(?=$|[^a-z0-9+/=])/giu;

function slash(path: string): string {
  return path.split(sep).join('/');
}

export function fingerprintFixture(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function checkedPath(root: string, candidate: string): Promise<string | null> {
  if (isAbsolute(candidate)) throw new Error('scan_path_outside_repository');
  const lexical = resolve(root, candidate);
  if (!isWithin(root, lexical)) throw new Error('scan_path_outside_repository');
  try {
    const physical = await realpath(lexical);
    if (!isWithin(root, physical)) throw new Error('scan_path_outside_repository');
    return physical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function walkDirectory(root: string, directory: string, visited = new Set<string>()): Promise<string[]> {
  const physical = await checkedPath(root, directory);
  if (!physical) return [];
  if (visited.has(physical)) return [];
  visited.add(physical);
  const files: string[] = [];
  for (const entry of await readdir(physical, { withFileTypes: true })) {
    const child = resolve(physical, entry.name);
    const childPhysical = await realpath(child);
    if (!isWithin(root, childPhysical)) throw new Error('scan_path_outside_repository');
    const stat = await lstat(childPhysical);
    if (stat.isDirectory()) files.push(...await walkDirectory(root, slash(relative(root, childPhysical)), visited));
    else if (stat.isFile()) files.push(childPhysical);
  }
  return files;
}

function gitTrackedFiles(root: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('git_tracked_files_unavailable');
  return result.stdout.split('\0').filter(Boolean);
}

async function filesToScan(root: string, trackedFiles?: readonly string[]): Promise<Array<{ absolute: string; relative: string }>> {
  const physicalRoot = await realpath(root);
  const candidates: string[] = [];
  for (const tracked of trackedFiles ?? gitTrackedFiles(physicalRoot)) {
    const physical = await checkedPath(physicalRoot, tracked);
    if (physical) candidates.push(physical);
  }
  candidates.push(...await walkDirectory(physicalRoot, 'dist'));
  candidates.push(...await walkDirectory(physicalRoot, 'admin/dist'));
  return [...new Set(candidates)]
    .map((absolute) => ({ absolute, relative: slash(relative(physicalRoot, absolute)) }))
    .sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
}

function decodePercent(value: string): string | null {
  if (!/%[0-9a-f]{2}/iu.test(value)) return null;
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded === value ? null : decoded;
}

function decodeEscapes(value: string): string | null {
  if (!/\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})/iu.test(value)) return null;
  const decoded = value
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decoded === value ? null : decoded;
}

function decodedBase64Values(value: string): string[] {
  const decoded: string[] = [];
  for (const match of value.matchAll(base64CandidatePattern)) {
    const candidate = match[1]!;
    if (candidate.length % 4 === 1) continue;
    try {
      const bytes = Buffer.from(candidate, 'base64');
      if (bytes.length < 16) continue;
      const text = bytes.toString('utf8');
      const printable = [...text].filter((character) => character === '\n' || character === '\r' || character === '\t' || character >= ' ').length;
      if (printable / Math.max(text.length, 1) >= 0.9) decoded.push(text);
    } catch {
      // Malformed candidates are ordinary source text, not scanner failures.
    }
  }
  return decoded;
}

function variants(source: string): string[] {
  const values = new Set([source]);
  const percent = decodePercent(source);
  if (percent) values.add(percent);
  const escaped = decodeEscapes(source);
  if (escaped) values.add(escaped);
  for (const current of [...values]) {
    for (const decoded of decodedBase64Values(current)) values.add(decoded);
  }
  return [...values];
}

function isServiceRoleJwt(candidate: string): boolean {
  const parts = candidate.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload.role === 'string' && payload.role.toLowerCase() === 'service_role';
  } catch {
    return false;
  }
}

function isCredentialLike(candidate: string): boolean {
  if (/^(?:token|invalid-token|owner-token|visitor-token|expired-token|user-token|service-(?:role-)?(?:value|secret|credential)|fixture-[a-z0-9-]+)$/iu.test(candidate)) return false;
  if (candidate.includes('${') || candidate.length < 24 || isObviousPlaceholder(candidate)) return false;
  return true;
}

function isObviousPlaceholder(candidate: string): boolean {
  return /(?:example|fixture|placeholder|not[-_]?a[-_]?real|dummy|sample)/iu.test(candidate);
}

function recognizedCredential(pattern: RegExp, candidate: string): boolean {
  pattern.lastIndex = 0;
  const recognized = pattern.test(candidate) && !isObviousPlaceholder(candidate);
  pattern.lastIndex = 0;
  return recognized;
}

function matches(source: string): RuleMatch[] {
  const found: RuleMatch[] = [];
  for (const match of source.matchAll(providerKeyPattern)) {
    if (!isObviousPlaceholder(match[0])) found.push({ rule: 'provider-key', value: match[0] });
  }
  for (const match of source.matchAll(githubTokenPattern)) {
    if (!isObviousPlaceholder(match[0])) found.push({ rule: 'github-token', value: match[0] });
  }
  for (const match of source.matchAll(jwtPattern)) {
    if (isServiceRoleJwt(match[0])) found.push({ rule: 'service-role-jwt', value: match[0] });
  }
  for (const match of source.matchAll(authorizationPattern)) {
    const credential = match[1]!;
    if (isCredentialLike(credential) || isServiceRoleJwt(credential)
      || recognizedCredential(providerKeyPattern, credential)
      || recognizedCredential(githubTokenPattern, credential)) {
      found.push({ rule: 'authorization-header', value: credential });
    }
  }
  for (const match of source.matchAll(rawPromptPattern)) {
    found.push({ rule: 'raw-prompt-field', value: match[1] ?? match[2] ?? match[3] ?? '' });
  }
  return found;
}

export async function scanNarrativeSecrets(options: NarrativeSecretScanOptions): Promise<NarrativeSecretFinding[]> {
  const root = await realpath(resolve(options.repoRoot));
  const allowed = options.allowedFixtureHashes ?? new Set<string>();
  const findings = new Map<string, NarrativeSecretFinding>();
  for (const file of await filesToScan(root, options.trackedFiles)) {
    const source = (await readFile(file.absolute)).toString('utf8');
    for (const representation of variants(source)) {
      for (const match of matches(representation)) {
        if (allowed.has(fingerprintFixture(match.value))) continue;
        const key = `${file.relative}\0${match.rule}`;
        findings.set(key, { file: file.relative, rule: match.rule });
      }
    }
  }
  return [...findings.values()].sort((left, right) => left.file.localeCompare(right.file, 'en') || left.rule.localeCompare(right.rule, 'en'));
}

export function formatSecretFindings(findings: readonly NarrativeSecretFinding[]): string {
  if (findings.length === 0) return 'Narrative secret scan passed.';
  return findings.map(({ file, rule }) => `${file}: ${rule}`).join('\n');
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const findings = await scanNarrativeSecrets({ repoRoot });
  const output = formatSecretFindings(findings);
  if (findings.length > 0) {
    console.error(output);
    process.exitCode = 1;
  } else {
    console.info(output);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'narrative_secret_scan_failed');
    process.exitCode = 1;
  });
}
