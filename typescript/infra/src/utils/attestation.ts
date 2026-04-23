import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';

const DEFAULT_REPO = 'hyperlane-xyz/hyperlane-monorepo';

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
    const raw = execSync(
      `gh attestation verify ${ref} --repo ${repo} --format json`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();

    const finishedOn = extractFinishedOn(raw);
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
      const statement = entry?.verificationResult?.statement ?? entry?.statement;
      const finishedOn =
        statement?.predicate?.runDetails?.metadata?.finishedOn ??
        statement?.predicate?.metadata?.buildFinishedOn;
      if (typeof finishedOn === 'string') {
        const d = new Date(finishedOn);
        if (!isNaN(d.getTime())) return d;
      }
    }
  } catch {
    // ignore - treated as "verified but age unknown"
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

export function printAttestationStatus(ref: ImageRef, status: AttestationStatus): void {
  const imageStr = `${ref.image}:${ref.tag}`;
  if (status.verified) {
    console.log(
      chalk.green(`✓ ${chalk.bold(ref.component)} attestation verified: ${imageStr}`),
    );
    if (status.finishedOn && status.ageMs != null) {
      console.log(
        chalk.gray(
          `  built: ${status.finishedOn.toISOString()}  (age: ${formatAge(status.ageMs)})`,
        ),
      );
    } else {
      console.log(chalk.gray('  build age: unknown (could not parse provenance)'));
    }
  } else {
    const bar = '!'.repeat(72);
    console.log('');
    console.log(chalk.red.bold(bar));
    console.log(
      chalk.red.bold(`ATTESTATION VERIFY FAILED for ${ref.component} (${imageStr})`),
    );
    console.log(
      chalk.red.bold(
        'Image may not have been built by this repo\'s CI. Supply-chain risk.',
      ),
    );
    console.log(chalk.red(`reason: ${status.reason.split('\n')[0]}`));
    console.log(chalk.red.bold(bar));
    console.log('');
  }
}

export async function preflightVerifyImages(
  refs: ImageRef[],
): Promise<{ allVerified: boolean; results: Array<{ ref: ImageRef; status: AttestationStatus }> }> {
  const seen = new Set<string>();
  const results: Array<{ ref: ImageRef; status: AttestationStatus }> = [];
  let allVerified = true;

  for (const ref of refs) {
    const key = `${ref.image}:${ref.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const status = await verifyImageAttestation({ image: ref.image, tag: ref.tag });
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

  const message = allVerified
    ? 'All attestations verified. Continue with deploy?'
    : chalk.red.bold(
        'One or more images FAILED attestation verify. Continue with deploy anyway?',
      );

  const shouldContinue = await confirm({
    message,
    default: allVerified,
  });

  if (!shouldContinue) {
    console.log(chalk.red.bold('Exiting...'));
    process.exit(1);
  }
}
