import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const DEFAULT_REPO = 'hyperlane-xyz/hyperlane-monorepo';
const YOUNG_BUILD_THRESHOLD_MS = 60 * 60 * 1000; // 1h

export type AttestationStatus =
  | {
      verified: true;
      finishedOn?: Date;
      ageMs?: number;
      ageUnknownReason?: string;
    }
  | {
      verified: false;
      reason: string;
    };

export interface ImageRef {
  component: string;
  image: string; // e.g. ghcr.io/hyperlane-xyz/hyperlane-agent
  tag: string;
}

export async function verifyImageAttestation({
  image,
  tag,
  repo = DEFAULT_REPO,
}: {
  image: string;
  tag: string;
  repo?: string;
}): Promise<AttestationStatus> {
  const ref = `oci://${image}:${tag}`;
  try {
    const { stdout } = await execFileP(
      'gh',
      ['attestation', 'verify', ref, '--repo', repo, '--format', 'json'],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const { date, reason } = extractFinishedOn(stdout);
    if (!date) {
      return { verified: true, ageUnknownReason: reason };
    }
    return {
      verified: true,
      finishedOn: date,
      ageMs: Date.now() - date.getTime(),
    };
  } catch (err: unknown) {
    if (isNodeErrorCode(err, 'ENOENT')) {
      throw new Error(
        'gh CLI not found on PATH — install from https://cli.github.com to run attestation preflight. (This is a tooling error, not an image problem.)',
      );
    }
    return { verified: false, reason: extractErrorMessage(err) };
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === code
  );
}

function extractErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return String(err);
  }
  const stderr = 'stderr' in err ? String(err.stderr ?? '').trim() : '';
  const stdout = 'stdout' in err ? String(err.stdout ?? '').trim() : '';
  const message = err instanceof Error ? err.message : '';
  return stderr || stdout || message || 'unknown error';
}

interface FinishedOnResult {
  date?: Date;
  reason?: string;
}

function extractFinishedOn(rawJson: string): FinishedOnResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      reason: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    // 1. SLSA provenance predicate (if present — not populated by
    //    GitHub's attest-build-provenance, but other producers may)
    const statementCandidates: unknown[] = [
      pickPath(entry, [['verificationResult', 'statement'], ['statement']]),
    ];
    const dssePayload = pickPath(entry, [
      ['attestation', 'bundle', 'dsseEnvelope', 'payload'],
      ['bundle', 'dsseEnvelope', 'payload'],
    ]);
    if (typeof dssePayload === 'string') {
      try {
        statementCandidates.push(
          JSON.parse(Buffer.from(dssePayload, 'base64').toString('utf8')),
        );
      } catch {
        // ignore, fall through to next candidate / tlog fallback
      }
    }
    for (const c of statementCandidates) {
      const date = readFinishedOn(c);
      if (date) return { date };
    }

    // 2. Rekor transparency-log integratedTime — when the attestation
    //    was signed (typically within seconds of build completion).
    const tlogEntries = pickPath(entry, [
      ['attestation', 'bundle', 'verificationMaterial', 'tlogEntries'],
      ['bundle', 'verificationMaterial', 'tlogEntries'],
    ]);
    if (Array.isArray(tlogEntries)) {
      for (const t of tlogEntries) {
        const raw =
          typeof t === 'object' && t !== null && 'integratedTime' in t
            ? (t as { integratedTime: unknown }).integratedTime
            : undefined;
        const seconds =
          typeof raw === 'string'
            ? Number(raw)
            : typeof raw === 'number'
              ? raw
              : NaN;
        if (Number.isFinite(seconds) && seconds > 0) {
          return { date: new Date(seconds * 1000) };
        }
      }
    }
  }

  return {
    reason:
      'no finishedOn in SLSA predicate and no Rekor integratedTime in bundle',
  };
}

function readFinishedOn(statement: unknown): Date | undefined {
  if (typeof statement !== 'object' || statement === null) return undefined;
  const value = pickPath(statement, [
    ['predicate', 'runDetails', 'metadata', 'finishedOn'],
    ['predicate', 'metadata', 'buildFinishedOn'],
  ]);
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return undefined;
}

function pickPath(root: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    let node: unknown = root;
    for (const key of path) {
      if (typeof node !== 'object' || node === null) {
        node = undefined;
        break;
      }
      // CAST: safe after typeof === 'object' && !== null guard above;
      // TS does not narrow unknown to an indexable shape on its own.
      node = (node as Record<string, unknown>)[key];
    }
    if (node !== undefined) return node;
  }
  return undefined;
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function printAttestationStatus(
  ref: ImageRef,
  status: AttestationStatus,
): void {
  const imageStr = `${ref.image}:${ref.tag}`;
  if (status.verified) {
    console.log(
      chalk.green(
        `✓ ${chalk.bold(ref.component)} attestation verified: ${imageStr}`,
      ),
    );
    if (status.finishedOn && status.ageMs != null) {
      const line = `  built: ${status.finishedOn.toISOString()}  (age: ${formatAge(status.ageMs)})`;
      if (status.ageMs < YOUNG_BUILD_THRESHOLD_MS) {
        console.log(
          chalk.yellow(
            `${line}  ⚠ young build — consider a soak period before prod`,
          ),
        );
      } else {
        console.log(chalk.gray(line));
      }
    } else {
      const why = status.ageUnknownReason ?? 'no timestamp in provenance';
      console.log(chalk.gray(`  build age: unknown (${why})`));
    }
  } else {
    const bar = '!'.repeat(72);
    console.log('');
    console.log(chalk.red.bold(bar));
    console.log(
      chalk.red.bold(
        `ATTESTATION VERIFY FAILED for ${ref.component} (${imageStr})`,
      ),
    );
    console.log(
      chalk.red.bold(
        "Image may not have been built by this repo's CI. Supply-chain risk.",
      ),
    );
    console.log(chalk.red(`reason: ${status.reason.split('\n')[0]}`));
    console.log(chalk.red.bold(bar));
    console.log('');
  }
}

export async function preflightVerifyImages(refs: ImageRef[]): Promise<{
  allVerified: boolean;
  results: Array<{ ref: ImageRef; status: AttestationStatus }>;
}> {
  // Group refs by image:tag so that when multiple components share a
  // tag (common during coordinated agent releases), we verify once but
  // still surface every component name in the printed status line.
  const groups = new Map<
    string,
    { components: string[]; image: string; tag: string; refs: ImageRef[] }
  >();
  for (const ref of refs) {
    const key = `${ref.image}:${ref.tag}`;
    const existing = groups.get(key);
    if (existing) {
      existing.components.push(ref.component);
      existing.refs.push(ref);
    } else {
      groups.set(key, {
        components: [ref.component],
        image: ref.image,
        tag: ref.tag,
        refs: [ref],
      });
    }
  }

  const groupList = [...groups.values()];
  const statuses = await Promise.all(
    groupList.map((g) =>
      verifyImageAttestation({ image: g.image, tag: g.tag }),
    ),
  );

  const results: Array<{ ref: ImageRef; status: AttestationStatus }> = [];
  let allVerified = true;
  for (let i = 0; i < groupList.length; i++) {
    const group = groupList[i];
    const status = statuses[i];
    printAttestationStatus(
      {
        component: group.components.join(', '),
        image: group.image,
        tag: group.tag,
      },
      status,
    );
    for (const ref of group.refs) {
      results.push({ ref, status });
    }
    if (!status.verified) allVerified = false;
  }

  return { allVerified, results };
}

export async function verifyImagesAndConfirm(refs: ImageRef[]): Promise<void> {
  if (refs.length === 0) return;

  console.log(chalk.grey.italic('Verifying image attestations...'));
  const { allVerified } = await preflightVerifyImages(refs);

  if (allVerified) return;

  const shouldContinue = await confirm({
    message: chalk.red.bold(
      'One or more images FAILED attestation verify. Continue with deploy anyway?',
    ),
    default: false,
  });

  if (!shouldContinue) {
    console.log(chalk.red.bold('Exiting...'));
    process.exit(1);
  }
}
