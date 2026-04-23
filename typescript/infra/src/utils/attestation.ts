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

    const finishedOn = extractFinishedOn(stdout);
    if (!finishedOn) {
      return { verified: true };
    }
    return {
      verified: true,
      finishedOn,
      ageMs: Date.now() - finishedOn.getTime(),
    };
  } catch (err: unknown) {
    return { verified: false, reason: extractErrorMessage(err) };
  }
}

function extractErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return err instanceof Error ? err.message : 'unknown error';
  }
  const stderr = 'stderr' in err ? String(err.stderr ?? '').trim() : '';
  const stdout = 'stdout' in err ? String(err.stdout ?? '').trim() : '';
  const message = err instanceof Error ? err.message : '';
  return stderr || stdout || message || 'unknown error';
}

function extractFinishedOn(rawJson: string): Date | undefined {
  try {
    const parsed = JSON.parse(rawJson);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      // 1. SLSA provenance predicate (if present — not populated by
      //    GitHub's attest-build-provenance, but other producers may)
      const statementCandidates: unknown[] = [
        entry?.verificationResult?.statement,
        entry?.statement,
      ];
      const dssePayload =
        entry?.attestation?.bundle?.dsseEnvelope?.payload ??
        entry?.bundle?.dsseEnvelope?.payload;
      if (typeof dssePayload === 'string') {
        try {
          statementCandidates.push(
            JSON.parse(Buffer.from(dssePayload, 'base64').toString('utf8')),
          );
        } catch {
          // ignore, next candidate
        }
      }
      for (const c of statementCandidates) {
        const date = readFinishedOn(c);
        if (date) return date;
      }

      // 2. Rekor transparency-log integratedTime — when the attestation
      //    was signed (typically within seconds of build completion).
      const tlogEntries =
        entry?.attestation?.bundle?.verificationMaterial?.tlogEntries ??
        entry?.bundle?.verificationMaterial?.tlogEntries;
      if (Array.isArray(tlogEntries)) {
        for (const t of tlogEntries) {
          const raw = t?.integratedTime;
          const seconds =
            typeof raw === 'string'
              ? Number(raw)
              : typeof raw === 'number'
                ? raw
                : NaN;
          if (Number.isFinite(seconds) && seconds > 0) {
            return new Date(seconds * 1000);
          }
        }
      }
    }
  } catch {
    // ignore - treated as "verified but age unknown"
  }
  return undefined;
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
      console.log(
        chalk.gray('  build age: unknown (could not parse provenance)'),
      );
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
  const unique: ImageRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.image}:${ref.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }

  const statuses = await Promise.all(
    unique.map((ref) =>
      verifyImageAttestation({ image: ref.image, tag: ref.tag }),
    ),
  );

  const results: Array<{ ref: ImageRef; status: AttestationStatus }> = [];
  let allVerified = true;
  for (let i = 0; i < unique.length; i++) {
    const ref = unique[i];
    const status = statuses[i];
    printAttestationStatus(ref, status);
    results.push({ ref, status });
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
