#!/usr/bin/env tsx
/**
 * Propagates standing quotes from DEFAULT target slots to per-router target slots.
 *
 * For each (origin, sourceToken, destination) group in the CROSS/moonpay route:
 *   1. Reads the DEFAULT OQLF slot's active standing quote value.
 *   2. Submits that value as a new 7-day standing quote to every non-DEFAULT
 *      (per-router) slot whose current effective value DIFFERS from DEFAULT's.
 *
 * Dry-run is the default (or pass --dry-run explicitly). Pass --propose to
 * actually submit transactions. In dry-run mode no signer/submitter keys are
 * fetched — the plan is derived from public on-chain reads only.
 *
 * The signer key (GCP quotesigner) signs the EIP-712 data; the gas-paying
 * submitter key defaults to the GCP mainnet3 deployer key when -k is omitted.
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts --dry-run
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts --propose
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts --propose -k 0x<key>
 */

import { Wallet } from 'ethers';
import yargs from 'yargs';

import { confirm } from '@inquirer/prompts';

import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

import {
  GCP_DEPLOYER_SECRET,
  GCP_SIGNER_SECRET,
  OqlfSlot,
  QuoteSubmission,
  discoverOqlfSlots,
  fmtBps,
  resolveGcpKey,
  submitQuoteWithRetry,
} from './oqlf-lib.js';

const TTL_7D = 7 * 86_400;

async function main(): Promise<void> {
  const {
    registry: registryUri,
    signerKey: signerKeyArg,
    submitterKey: submitterKeyArg,
    propose,
    dryRun: dryRunArg,
  } = await yargs(process.argv.slice(2))
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://…)',
    })
    .option('signer-key', {
      alias: 's',
      type: 'string',
      describe:
        'Private key (0x…) of the EIP-712 quote signer. ' +
        'Defaults to GCP secret hyperlane-mainnet3-key-quotesigner.',
    })
    .option('submitter-key', {
      alias: 'k',
      type: 'string',
      describe:
        'Private key (0x…) of the gas-paying submitter. ' +
        'Defaults to GCP mainnet3 deployer key when omitted.',
    })
    .option('propose', {
      type: 'boolean',
      default: false,
      describe: 'Submit transactions on-chain (default: dry run only).',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe:
        'Explicitly force a dry run (this is also the default when ' +
        '--propose is omitted). No signer/submitter keys are fetched.',
    })
    .parseAsync();

  // --propose is the only thing that can turn off dry-run; --dry-run always wins.
  const effectiveDryRun = dryRunArg || !propose;

  // Signing/submitter keys are only needed to sign and submit — skip fetching
  // them entirely for a dry run so a preview never requires GCP credentials.
  let signerKey: string | undefined;
  let submitterWallet: Wallet | undefined;
  if (!effectiveDryRun) {
    // Signing key: custom if provided, else GCP secret. No ETH needed — only signs EIP-712.
    if (signerKeyArg) {
      signerKey = signerKeyArg.startsWith('0x')
        ? signerKeyArg
        : `0x${signerKeyArg}`;
      console.log(`Signer:    ${new Wallet(signerKey).address}`);
    } else {
      const signerSecret = await resolveGcpKey(GCP_SIGNER_SECRET);
      signerKey = signerSecret.privateKey;
      console.log(`Signer:    ${signerSecret.address}`);
    }

    let submitterKeyRaw = submitterKeyArg ?? process.env.PRIVATE_KEY;
    if (!submitterKeyRaw) {
      const deployerSecret = await resolveGcpKey(GCP_DEPLOYER_SECRET);
      submitterKeyRaw = deployerSecret.privateKey;
      console.log(`Submitter: ${deployerSecret.address} (mainnet3 deployer)`);
    }
    const k = submitterKeyRaw.startsWith('0x')
      ? submitterKeyRaw
      : `0x${submitterKeyRaw}`;
    submitterWallet = new Wallet(k);
    if (submitterKeyArg || process.env.PRIVATE_KEY) {
      console.log(`Submitter: ${submitterWallet.address}`);
    }
  } else {
    console.log('Mode:      DRY RUN (pass --propose to submit transactions)');
  }

  // For chain metadata (and thus RPC URLs), use the HTTP registry when -r is
  // provided — it overlays private RPC URLs without replacing the filesystem
  // registry that getWarpCoreConfig / getDomainId rely on (same as
  // print-quotes.ts / set-quotes.ts).
  const rpcRegistry = registryUri
    ? getMergedRegistry({ registryUris: [registryUri], enableProxy: true })
    : getRegistry();
  const chainMetadata = await rpcRegistry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);

  // ── Scan slots ────────────────────────────────────────────────────────────
  console.log('\nScanning OQLF slots...\n');
  const allSlots: OqlfSlot[] = await discoverOqlfSlots(multiProvider);

  // ── Build propagation plan ─────────────────────────────────────────────────

  // Group by (origin, sourceToken, destination) to pair DEFAULT with per-router slots.
  const groups = new Map<
    string,
    { defaultSlot: OqlfSlot | null; perRouterSlots: OqlfSlot[] }
  >();
  for (const slot of allSlots) {
    const key = `${slot.origin}:${slot.sourceToken}:${slot.destination}`;
    const g = groups.get(key) ?? { defaultSlot: null, perRouterSlots: [] };
    if (slot.isDefault) {
      g.defaultSlot = slot;
    } else {
      g.perRouterSlots.push(slot);
    }
    groups.set(key, g);
  }

  // Collect slots to update: per-router slots whose effective value differs
  // from the DEFAULT slot's active standing quote value. Compare the raw
  // maxFee/halfAmount values, not the display-rounded bps string, so a real
  // (sub-display-precision) difference isn't skipped.
  const toSubmit: Array<{
    submission: QuoteSubmission;
    sourceBps: string;
    currentBps: string;
  }> = [];

  for (const [, { defaultSlot, perRouterSlots }] of groups) {
    // Only propagate when DEFAULT has an active standing quote.
    if (!defaultSlot || defaultSlot.effectiveSource !== 'standing') continue;
    const sourceBps = fmtBps(
      defaultSlot.effectiveMaxFee,
      defaultSlot.effectiveHalfAmount,
    );
    for (const slot of perRouterSlots) {
      if (
        slot.effectiveMaxFee === defaultSlot.effectiveMaxFee &&
        slot.effectiveHalfAmount === defaultSlot.effectiveHalfAmount
      )
        continue;
      const currentBps = fmtBps(slot.effectiveMaxFee, slot.effectiveHalfAmount);
      toSubmit.push({
        submission: {
          slot,
          maxFee: defaultSlot.effectiveMaxFee,
          halfAmount: defaultSlot.effectiveHalfAmount,
          bpsLabel: sourceBps,
        },
        sourceBps,
        currentBps,
      });
    }
  }

  toSubmit.sort((a, b) => {
    return (
      a.submission.slot.origin.localeCompare(b.submission.slot.origin) ||
      a.submission.slot.sourceToken.localeCompare(
        b.submission.slot.sourceToken,
      ) ||
      a.submission.slot.destination.localeCompare(
        b.submission.slot.destination,
      ) ||
      a.submission.slot.target.localeCompare(b.submission.slot.target)
    );
  });

  if (toSubmit.length === 0) {
    console.log(
      'No per-router slots need updating (all match their DEFAULT standing quote).',
    );
    return;
  }

  // ── Print plan ────────────────────────────────────────────────────────────
  console.log(`${toSubmit.length} per-router slot(s) to propagate (TTL 7d):\n`);
  const W = {
    origin: Math.max(
      6,
      ...toSubmit.map((r) => r.submission.slot.origin.length),
    ),
    src: Math.max(
      3,
      ...toSubmit.map((r) => r.submission.slot.sourceToken.length),
    ),
    dest: Math.max(
      4,
      ...toSubmit.map((r) => r.submission.slot.destination.length),
    ),
    target: Math.max(
      6,
      ...toSubmit.map((r) => r.submission.slot.target.length),
    ),
    cur: Math.max(7, ...toSubmit.map((r) => r.currentBps.length)),
  };
  const pad = (s: string, n: number) =>
    s.length >= n ? s : s + ' '.repeat(n - s.length);
  console.log(
    `${pad('origin', W.origin)}   ${pad('src', W.src)} → ${pad('dest', W.dest)}   ${pad('target', W.target)}   ${pad('current', W.cur)}   new`,
  );
  console.log(
    [W.origin, W.src, W.dest, W.target, W.cur, 8]
      .map((w) => '─'.repeat(w))
      .join('   '),
  );
  for (const { submission, sourceBps, currentBps } of toSubmit) {
    const { slot } = submission;
    console.log(
      `${pad(slot.origin, W.origin)}   ${pad(slot.sourceToken, W.src)} → ${pad(slot.destination, W.dest)}   ${pad(slot.target, W.target)}   ${pad(currentBps, W.cur)}   ${sourceBps}`,
    );
  }
  console.log();

  if (effectiveDryRun) {
    console.log('Dry run complete. Pass --propose to submit transactions.');
    return;
  }

  assert(
    signerKey !== undefined && submitterWallet !== undefined,
    'signer/submitter keys are required when --propose is set',
  );

  const confirmed = await confirm({
    message: `Submit ${toSubmit.length} quote(s)?`,
    default: false,
  });
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  // ── Sign and submit ────────────────────────────────────────────────────────

  const results: Array<{ submission: QuoteSubmission; error?: unknown }> = [];
  for (const { submission } of toSubmit) {
    try {
      await submitQuoteWithRetry(
        multiProvider,
        signerKey,
        submitterWallet,
        submission,
        TTL_7D,
      );
      results.push({ submission });
    } catch (error) {
      results.push({ submission, error });
    }
  }

  const failed = results.filter((r) => r.error !== undefined);
  console.log(
    `\n${results.length - failed.length}/${results.length} quote(s) propagated successfully.`,
  );
  if (failed.length > 0) {
    console.error('\nFailed submissions (state to reconcile manually):');
    for (const { submission, error } of failed) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `  ${submission.slot.origin} (${submission.slot.sourceToken}) → ${submission.slot.destination} / ${submission.slot.target}: ${msg}`,
      );
    }
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
