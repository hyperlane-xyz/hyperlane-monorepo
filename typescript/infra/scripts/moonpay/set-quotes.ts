#!/usr/bin/env tsx
/**
 * Interactively sets standing quotes for CROSS/MoonPay warp routes.
 * Signs EIP-712 quotes and submits them on-chain via OQLF.submitQuote().
 *
 * Standing quotes are stored in OQLF.quotes[destDomain][WILDCARD_RECIPIENT]
 * and expire after --ttl seconds (default 24 h). Any address may submit
 * since submitter = address(0).
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/set-quotes.ts
 *   pnpm tsx scripts/moonpay/set-quotes.ts -r http://localhost:3000
 *   pnpm tsx scripts/moonpay/set-quotes.ts --dry-run --origins arbitrum --bps 5 ...
 */

import { Wallet } from 'ethers';
import yargs from 'yargs';

import { checkbox, confirm, input } from '@inquirer/prompts';

import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

import {
  GCP_DEPLOYER_SECRET,
  GCP_SIGNER_SECRET,
  OqlfSlot,
  QuoteSubmission,
  bpsToParams,
  discoverOqlfSlots,
  fmtBps,
  resolveGcpKey,
  submitQuoteWithRetry,
  verifySignerAuthorization,
} from './oqlf-lib.js';

const DEFAULT_TTL = 86_400; // 24 hours

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Parses a TTL string with a mandatory unit suffix (s/h/d) — a bare number
 * is rejected so the same input can never be interpreted as seconds in one
 * code path and hours in another. Only whole seconds are accepted since the
 * on-chain expiry is a uint48 of seconds.
 */
function parseTtl(v: string): number | null {
  const t = v.trim().toLowerCase();
  const m = t.match(/^(\d+(?:\.\d+)?)(s|h|d)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  const multiplier = unit === 's' ? 1 : unit === 'h' ? 3600 : 86_400;
  const seconds = n * multiplier;
  return Number.isInteger(seconds) ? seconds : null;
}

// Resolve a comma-separated flag value ("all" = every available item).
// Returns null when the flag was not provided → caller should prompt.
function resolveFlag(
  flag: string | undefined,
  available: string[],
): string[] | null {
  if (flag === undefined) return null;
  if (flag.toLowerCase() === 'all') return [...available];
  return flag
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    registry: registryUri,
    ttl: ttlRawArg,
    signerKey: signerKeyArg,
    submitterKey: submitterKeyArg,
    origins: originsArg,
    sourceTokens: sourceTokensArg,
    destinations: destinationsArg,
    targets: targetsArg,
    bps: bpsArg,
    yes: autoConfirm,
    dryRun,
  } = await yargs(process.argv.slice(2))
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://…)',
    })
    .option('ttl', {
      type: 'string',
      describe:
        'Standing quote TTL with a unit suffix (e.g. 24h, 2d, 86400s). ' +
        'Skips the TTL prompt when provided.',
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
        'Private key (0x…) of the gas-paying submitter account. ' +
        'Defaults to PRIVATE_KEY env var. ' +
        'The quote signer signs; this account pays gas.',
    })
    .option('origins', {
      alias: 'o',
      type: 'string',
      describe:
        'Comma-separated origin chain names, or "all". Skips the origin prompt.',
    })
    .option('source-tokens', {
      type: 'string',
      describe:
        'Comma-separated source token groups (e.g. "USDC,USDT"), or "all". ' +
        'Skips the source token prompt.',
    })
    .option('destinations', {
      alias: 'd',
      type: 'string',
      describe:
        'Comma-separated destination chain names, or "all". Skips the destination prompt.',
    })
    .option('targets', {
      alias: 't',
      type: 'string',
      describe:
        'Comma-separated target groups (e.g. "DEFAULT,USDC"), or "all". ' +
        'Skips the target prompt.',
    })
    .option('bps', {
      type: 'number',
      describe:
        'Fee in bps to apply to all selected slots. Skips per-slot prompts.',
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      default: false,
      describe: 'Skip the confirmation prompt.',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe:
        'Print the lanes that would be updated and to what bps, without ' +
        'signing or submitting anything. No signer/submitter keys required.',
    })
    .parseAsync();

  // Signing/submitter keys are only needed to sign and submit — skip fetching
  // them entirely for --dry-run so a preview never requires GCP credentials.
  let signerKey: string | undefined;
  let submitterWallet: Wallet | undefined;
  if (!dryRun) {
    // Signing key: custom if provided, else GCP secret. No ETH needed — only signs EIP-712.
    if (signerKeyArg) {
      signerKey = signerKeyArg.startsWith('0x')
        ? signerKeyArg
        : `0x${signerKeyArg}`;
      console.log(`Signer:    ${new Wallet(signerKey).address}`);
    } else {
      const secret = await resolveGcpKey(GCP_SIGNER_SECRET);
      signerKey = secret.privateKey;
      console.log(`Signer:    ${secret.address}`);
    }

    // Submitter key: pays gas for submitQuote(). Defaults to GCP mainnet3 deployer key.
    let submitterKeyRaw = submitterKeyArg ?? process.env.PRIVATE_KEY;
    if (!submitterKeyRaw) {
      const deployerSecret = await resolveGcpKey(GCP_DEPLOYER_SECRET);
      submitterKeyRaw = deployerSecret.privateKey;
      console.log(`Submitter: ${deployerSecret.address} (mainnet3 deployer)`);
    }
    const submitterKey = submitterKeyRaw.startsWith('0x')
      ? submitterKeyRaw
      : `0x${submitterKeyRaw}`;
    submitterWallet = new Wallet(submitterKey);
    if (submitterKeyArg || process.env.PRIVATE_KEY) {
      console.log(`Submitter: ${submitterWallet.address}`);
    }
  }

  // HTTP registry overlays private RPC URLs; filesystem registry handles warp configs.
  const rpcRegistry = registryUri
    ? getMergedRegistry({ registryUris: [registryUri], enableProxy: true })
    : getRegistry();
  const chainMetadata = await rpcRegistry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);

  // ── Discover all OQLF slots ────────────────────────────────────────────────
  console.log('\nDiscovering OQLF slots (one-time RPC scan)...\n');
  const allSlots: OqlfSlot[] = await discoverOqlfSlots(multiProvider);

  console.log(`Found ${allSlots.length} OQLF slots.\n`);

  // ── Verify signer authorization on every unique (origin, OQLF) pair ────────
  if (!dryRun) {
    assert(
      signerKey !== undefined,
      'signer key is required when not --dry-run',
    );
    await verifySignerAuthorization(multiProvider, signerKey, allSlots);
  }

  // ── TTL ───────────────────────────────────────────────────────────────────

  let effectiveTtl: number;
  if (ttlRawArg !== undefined) {
    const parsed = parseTtl(ttlRawArg);
    assert(
      parsed !== null,
      `Invalid --ttl "${ttlRawArg}"; use a duration like 24h, 2d, or 86400s.`,
    );
    effectiveTtl = parsed;
    console.log(`TTL: ${(effectiveTtl / 3600).toFixed(1)} h`);
  } else {
    const defaultTtlStr =
      DEFAULT_TTL % 86_400 === 0
        ? `${DEFAULT_TTL / 86_400}d`
        : `${DEFAULT_TTL / 3600}h`;
    const ttlInput = await input({
      message: 'Standing quote TTL (e.g. 24h, 2d, or 86400s)',
      default: defaultTtlStr,
      validate: (v) =>
        parseTtl(v) !== null || 'Enter a duration like 24h, 2d, or 86400s.',
    });
    const parsed = parseTtl(ttlInput);
    assert(parsed !== null, `Invalid TTL "${ttlInput}"`);
    effectiveTtl = parsed;
  }

  // ── Filter selections ─────────────────────────────────────────────────────

  const availableOrigins = [...new Set(allSlots.map((s) => s.origin))].sort();
  const selectedChains =
    resolveFlag(originsArg, availableOrigins) ??
    (await checkbox({
      message: 'Select origin chains',
      choices: availableOrigins.map((c) => ({ value: c })),
      pageSize: 20,
      required: true,
    }));

  const availableSourceTokens = [
    ...new Set(allSlots.map((s) => s.sourceToken)),
  ].sort();
  const selectedSourceTokens =
    resolveFlag(sourceTokensArg, availableSourceTokens) ??
    (await checkbox({
      message: 'Select source token groups',
      choices: availableSourceTokens.map((t) => ({ value: t })),
      pageSize: 20,
      required: true,
    }));

  const availableDestinations = [
    ...new Set(allSlots.map((s) => s.destination)),
  ].sort();
  const selectedDestinations =
    resolveFlag(destinationsArg, availableDestinations) ??
    (await checkbox({
      message: 'Select destination chains',
      choices: availableDestinations.map((c) => ({ value: c })),
      pageSize: 20,
      required: true,
    }));

  const availableTargets = [...new Set(allSlots.map((s) => s.target))].sort(
    (a, b) => {
      if (a === 'DEFAULT') return -1;
      if (b === 'DEFAULT') return 1;
      return a.localeCompare(b);
    },
  );
  const selectedTargets =
    resolveFlag(targetsArg, availableTargets) ??
    (await checkbox({
      message: 'Select target token groups',
      choices: availableTargets.map((t) => ({ value: t })),
      pageSize: 20,
      required: true,
    }));

  const filteredSlots = allSlots.filter(
    (s) =>
      selectedChains.includes(s.origin) &&
      selectedSourceTokens.includes(s.sourceToken) &&
      selectedDestinations.includes(s.destination) &&
      selectedTargets.includes(s.target),
  );

  if (filteredSlots.length === 0) {
    console.log('\nNo slots match the selected filters.');
    return;
  }

  // ── Build submission queue ─────────────────────────────────────────────────

  const toSubmit: QuoteSubmission[] = [];

  if (bpsArg !== undefined) {
    // Non-interactive: apply the same bps to all filtered slots.
    const W = {
      origin: Math.max(6, ...filteredSlots.map((s) => s.origin.length)),
      src: Math.max(3, ...filteredSlots.map((s) => s.sourceToken.length)),
      dest: Math.max(4, ...filteredSlots.map((s) => s.destination.length)),
      target: Math.max(6, ...filteredSlots.map((s) => s.target.length)),
      cur: Math.max(
        7,
        ...filteredSlots.map(
          (s) => fmtBps(s.effectiveMaxFee, s.effectiveHalfAmount).length,
        ),
      ),
    };
    const pad = (s: string, n: number) =>
      s.length >= n ? s : s + ' '.repeat(n - s.length);
    let newBpsStr = '';
    console.log(
      `\n${filteredSlots.length} slot(s) → ${bpsArg} bps (TTL ${(effectiveTtl / 3600).toFixed(1)} h):\n`,
    );
    console.log(
      `${pad('origin', W.origin)}   ${pad('src', W.src)} → ${pad('dest', W.dest)}   ${pad('target', W.target)}   ${pad('current', W.cur)}   new`,
    );
    console.log(
      [W.origin, W.src, W.dest, W.target, W.cur, 8]
        .map((w) => '─'.repeat(w))
        .join('   '),
    );
    for (const slot of filteredSlots) {
      const { maxFee, halfAmount } = bpsToParams(
        multiProvider,
        slot.origin,
        bpsArg,
      );
      newBpsStr = fmtBps(maxFee, halfAmount);
      const currentBpsStr = fmtBps(
        slot.effectiveMaxFee,
        slot.effectiveHalfAmount,
      );
      console.log(
        `${pad(slot.origin, W.origin)}   ${pad(slot.sourceToken, W.src)} → ${pad(slot.destination, W.dest)}   ${pad(slot.target, W.target)}   ${pad(currentBpsStr, W.cur)}   ${newBpsStr}`,
      );
      toSubmit.push({ slot, maxFee, halfAmount, bpsLabel: newBpsStr });
    }
    console.log();
  } else {
    // Interactive: prompt bps per slot.
    console.log(
      `\n${filteredSlots.length} combination(s) to review.\n` +
        'For each: enter bps, ↵ skip, "d" for on-chain default.\n',
    );
    for (const slot of filteredSlots) {
      const currentBpsStr = fmtBps(
        slot.effectiveMaxFee,
        slot.effectiveHalfAmount,
      );
      const fallbackBpsStr = fmtBps(slot.onchainMaxFee, slot.onchainHalfAmount);
      const effectiveLine =
        slot.effectiveSource === 'standing'
          ? `  effective : ${currentBpsStr} bps (standing quote — overrides fallback)`
          : `  effective : ${currentBpsStr} bps (no standing quote, using fallback)`;
      console.log(
        `\n${slot.origin} (${slot.sourceToken}) → ${slot.destination}  /  ${slot.target}\n` +
          effectiveLine +
          `\n  fallback  : ${fallbackBpsStr} bps`,
      );

      const raw = await input({
        message: 'new bps [↵=skip, d=reset to fallback]',
        default: '',
        validate: (v) => {
          const t = v.trim();
          if (t === '' || t === 'd') return true;
          const n = Number(t);
          if (Number.isFinite(n) && n > 0) return true;
          return 'Enter a positive number, ↵ to skip, or "d" for on-chain default.';
        },
      });

      const trimmed = raw.trim();
      if (trimmed === '') {
        console.log('  → skipped.');
        continue;
      }

      let maxFee: bigint;
      let halfAmount: bigint;
      let newBpsStr: string;

      if (trimmed === 'd') {
        maxFee = slot.onchainMaxFee;
        halfAmount = slot.onchainHalfAmount;
        newBpsStr = fallbackBpsStr;
      } else {
        ({ maxFee, halfAmount } = bpsToParams(
          multiProvider,
          slot.origin,
          Number(trimmed),
        ));
        newBpsStr = fmtBps(maxFee, halfAmount);
      }

      console.log(`  → queued: ${newBpsStr} bps`);
      toSubmit.push({ slot, maxFee, halfAmount, bpsLabel: newBpsStr });
    }
  }

  if (toSubmit.length === 0) {
    console.log('\nNothing to submit.');
    return;
  }

  if (dryRun) {
    console.log('Dry run complete. No quotes were submitted.');
    return;
  }

  assert(
    signerKey !== undefined && submitterWallet !== undefined,
    'signer/submitter keys are required when not --dry-run',
  );

  // ── Confirm ────────────────────────────────────────────────────────────────

  if (!autoConfirm) {
    const ttlHours = (effectiveTtl / 3600).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${toSubmit.length} quote(s) to submit (TTL ${ttlHours} h):`);
    for (const { slot, bpsLabel } of toSubmit) {
      console.log(
        `  ${slot.origin} (${slot.sourceToken}) → ${slot.destination}  /  ${slot.target}  →  ${bpsLabel} bps`,
      );
    }
    console.log('═'.repeat(60));
    const confirmed = await confirm({ message: 'Submit?', default: false });
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  // ── Sign and submit ────────────────────────────────────────────────────────

  const results: Array<{ submission: QuoteSubmission; error?: unknown }> = [];
  for (const submission of toSubmit) {
    try {
      await submitQuoteWithRetry(
        multiProvider,
        signerKey,
        submitterWallet,
        submission,
        effectiveTtl,
      );
      results.push({ submission });
    } catch (error) {
      results.push({ submission, error });
    }
  }

  const failed = results.filter((r) => r.error !== undefined);
  console.log(
    `\n${results.length - failed.length}/${results.length} quote(s) submitted successfully.`,
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
