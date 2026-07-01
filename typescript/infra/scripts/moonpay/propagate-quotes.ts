#!/usr/bin/env tsx
/**
 * Propagates standing quotes from DEFAULT target slots to per-router target slots.
 *
 * For each (origin, sourceToken, destination) group in the CROSS/moonpay route:
 *   1. Reads the DEFAULT OQLF slot's active standing quote value.
 *   2. Submits that value as a new 7-day standing quote to every non-DEFAULT
 *      (per-router) slot whose current effective value DIFFERS from DEFAULT's.
 *
 * Dry-run is the default. Pass --propose to actually submit transactions.
 *
 * The signer key (GCP quotesigner) signs the EIP-712 data; the gas-paying
 * submitter key defaults to the GCP mainnet3 deployer key when -k is omitted.
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts --propose
 *   pnpm tsx scripts/moonpay/propagate-quotes.ts --propose -k 0x<key>
 */

import { Wallet, constants, ethers } from 'ethers';
import yargs from 'yargs';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  OffchainQuotedLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider, OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  getDomainId,
  getRegistry,
  getWarpCoreConfig,
} from '../../config/registry.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { fetchGCPSecret } from '../../src/utils/gcloud.js';

const GCP_SIGNER_SECRET = 'hyperlane-mainnet3-key-quotesigner';
const GCP_DEPLOYER_SECRET = 'hyperlane-mainnet3-key-deployer';

// ── Constants ─────────────────────────────────────────────────────────────────

const WILDCARD_RECIPIENT = '0x' + 'ff'.repeat(32);
const WILDCARD_DEST = 0xffffffff;
const DEFAULT_ROUTER_KEY =
  '0x6e086cd647d6eb8b516856666e2c1465fb8a6a58d3a75938362acc674eacaf47';
const ROUTE_IDS = [WarpRouteIds.CROSSCitreaMoonpay];
const TTL_7D = 7 * 86_400;

const EIP712_NAME = 'OffchainQuoter';
const EIP712_VERSION = '1';
const SIGNED_QUOTE_TYPES = {
  SignedQuote: [
    { name: 'context', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'expiry', type: 'uint48' },
    { name: 'salt', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
  ],
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Slot {
  origin: string;
  sourceToken: string;
  destination: string;
  destDomain: number;
  /** 'DEFAULT' or normalised token label */
  target: string;
  isDefault: boolean;
  oqlfAddress: string;
  /** Current effective maxFee (standing or fallback) */
  effectiveMaxFee: bigint;
  /** Current effective halfAmount */
  effectiveHalfAmount: bigint;
  hasActiveStanding: boolean;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtBps(maxFee: bigint, halfAmount: bigint): string {
  if (halfAmount === 0n) return '?.??';
  const denom = halfAmount * 2n;
  const whole = (maxFee * 10_000n) / denom;
  const frac = (maxFee * 1_000_000n) / denom - whole * 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    registry: registryUri,
    signerKey: signerKeyArg,
    submitterKey: submitterKeyArg,
    propose,
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
    .parseAsync();

  // Signing key: custom if provided, else GCP secret. No ETH needed — only signs EIP-712.
  let signerKey: string;
  if (signerKeyArg) {
    signerKey = signerKeyArg.startsWith('0x')
      ? signerKeyArg
      : `0x${signerKeyArg}`;
    console.log(`Signer:    ${new Wallet(signerKey).address}`);
  } else {
    const signerSecret = (await fetchGCPSecret(GCP_SIGNER_SECRET)) as {
      privateKey: string;
      address: string;
    };
    signerKey = signerSecret.privateKey;
    console.log(`Signer:    ${signerSecret.address}`);
  }

  let submitterWallet: Wallet | null = null;
  if (propose) {
    const submitterKeyRaw =
      submitterKeyArg ??
      process.env.PRIVATE_KEY ??
      (await (async () => {
        const deployerSecret = (await fetchGCPSecret(GCP_DEPLOYER_SECRET)) as {
          privateKey: string;
          address: string;
        };
        console.log(`Submitter: ${deployerSecret.address} (mainnet3 deployer)`);
        return deployerSecret.privateKey;
      })());
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

  const rpcRegistry = registryUri
    ? getMergedRegistry({ registryUris: [registryUri], enableProxy: true })
    : getRegistry();
  const chainMetadata = await rpcRegistry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);

  const addrToLabel = new Map<string, string>();
  const routersByChain = new Map<string, string[]>();
  for (const routeId of ROUTE_IDS) {
    const warpConfig = getWarpCoreConfig(routeId);
    for (const t of warpConfig.tokens) {
      if (t.addressOrDenom) {
        const addr = t.addressOrDenom.startsWith('0x')
          ? t.addressOrDenom.toLowerCase()
          : t.addressOrDenom;
        const label =
          t.coinGeckoId === 'usd-coin'
            ? 'USDC'
            : t.coinGeckoId === 'tether'
              ? 'USDT'
              : (t.symbol ?? t.chainName ?? addr.slice(0, 10));
        addrToLabel.set(addr, label);
        if (t.chainName) {
          const list = routersByChain.get(t.chainName) ?? [];
          if (!list.includes(addr)) list.push(addr);
          routersByChain.set(t.chainName, list);
        }
      }
    }
  }

  // ── Scan slots ────────────────────────────────────────────────────────────
  console.log('\nScanning OQLF slots...\n');
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const allSlots: Slot[] = [];

  await Promise.all(
    ROUTE_IDS.flatMap((routeId) => {
      const warpConfig = getWarpCoreConfig(routeId);
      const evmTokens = warpConfig.tokens.filter(
        (t) =>
          t.addressOrDenom &&
          t.chainName &&
          /^0x[0-9a-f]{40}$/i.test(t.addressOrDenom),
      );
      return evmTokens.map(async (originToken) => {
        const { chainName: origin, addressOrDenom: routerAddr } = originToken;
        if (!routerAddr || !origin) return;
        const normalizedAddr = routerAddr.toLowerCase();
        const sourceToken =
          addrToLabel.get(normalizedAddr) ?? originToken.symbol ?? origin;
        const provider = multiProvider.getProvider(origin);

        let ccrAddress: string;
        try {
          ccrAddress = await TokenRouter__factory.connect(
            routerAddr,
            provider,
          ).feeRecipient();
        } catch {
          return;
        }
        if (!ccrAddress || ccrAddress === constants.AddressZero) return;

        let feeTypeNum: number;
        try {
          feeTypeNum = await BaseFee__factory.connect(
            ccrAddress,
            provider,
          ).feeType();
        } catch {
          return;
        }
        if (feeTypeNum !== OnchainTokenFeeType.CrossCollateralRoutingFee)
          return;

        const ccr = CrossCollateralRoutingFee__factory.connect(
          ccrAddress,
          provider,
        );
        const destTokens = warpConfig.tokens.filter((t) => !!t.chainName);

        await Promise.all(
          destTokens.map(async (destToken) => {
            const { chainName: destination } = destToken;
            if (!destination) return;
            let destDomain: number;
            try {
              destDomain = getDomainId(destination);
            } catch {
              return;
            }

            const destRouters = routersByChain.get(destination) ?? [];
            const targetKeys: Array<{
              key: string;
              label: string;
              isDefault: boolean;
            }> = [
              { key: DEFAULT_ROUTER_KEY, label: 'DEFAULT', isDefault: true },
              ...destRouters.map((addr) => ({
                key: addressToBytes32(addr),
                label: addrToLabel.get(addr) ?? addr.slice(0, 10),
                isDefault: false,
              })),
            ];

            await Promise.all(
              targetKeys.map(async ({ key, label, isDefault }) => {
                let oqlfAddress: string;
                try {
                  oqlfAddress = await ccr.feeContracts(destDomain, key);
                } catch {
                  return;
                }
                if (!oqlfAddress || oqlfAddress === constants.AddressZero)
                  return;

                const slotId = `${oqlfAddress.toLowerCase()}:${destDomain}:${sourceToken}`;
                if (seen.has(slotId)) return;
                seen.add(slotId);

                const oqlf = OffchainQuotedLinearFee__factory.connect(
                  oqlfAddress,
                  provider,
                );
                const [onchainMaxFee, onchainHalfAmount] = await Promise.all([
                  oqlf.maxFee(),
                  oqlf.halfAmount(),
                ]);

                let effectiveMaxFee = onchainMaxFee.toBigInt();
                let effectiveHalfAmount = onchainHalfAmount.toBigInt();
                let hasActiveStanding = false;

                for (const { dest, recip } of [
                  { dest: destDomain, recip: WILDCARD_RECIPIENT },
                  { dest: WILDCARD_DEST, recip: WILDCARD_RECIPIENT },
                ]) {
                  const sq = await oqlf.quotes(dest, recip);
                  const expiry = Number(sq.expiry);
                  if (expiry > 0 && expiry >= now) {
                    effectiveMaxFee = sq.maxFee.toBigInt();
                    effectiveHalfAmount = sq.halfAmount.toBigInt();
                    hasActiveStanding = true;
                    break;
                  }
                }

                allSlots.push({
                  origin,
                  sourceToken,
                  destination,
                  destDomain,
                  target: label,
                  isDefault,
                  oqlfAddress,
                  effectiveMaxFee,
                  effectiveHalfAmount,
                  hasActiveStanding,
                });
              }),
            );
          }),
        );
      });
    }),
  );

  // ── Build propagation plan ─────────────────────────────────────────────────

  // Group by (origin, sourceToken, destination) to pair DEFAULT with per-router slots.
  const groups = new Map<
    string,
    { defaultSlot: Slot | null; perRouterSlots: Slot[] }
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

  // Collect slots to update: per-router slots whose effective bps differs from
  // the DEFAULT slot's active standing quote value.
  const toSubmit: Array<{
    slot: Slot;
    maxFee: bigint;
    halfAmount: bigint;
    sourceBps: string;
    currentBps: string;
  }> = [];

  for (const [, { defaultSlot, perRouterSlots }] of groups) {
    // Only propagate when DEFAULT has an active standing quote.
    if (!defaultSlot?.hasActiveStanding) continue;
    const sourceBps = fmtBps(
      defaultSlot.effectiveMaxFee,
      defaultSlot.effectiveHalfAmount,
    );
    for (const slot of perRouterSlots) {
      const currentBps = fmtBps(slot.effectiveMaxFee, slot.effectiveHalfAmount);
      // Skip if per-router slot already shows the same effective value.
      if (currentBps === sourceBps) continue;
      toSubmit.push({
        slot,
        maxFee: defaultSlot.effectiveMaxFee,
        halfAmount: defaultSlot.effectiveHalfAmount,
        sourceBps,
        currentBps,
      });
    }
  }

  toSubmit.sort((a, b) => {
    return (
      a.slot.origin.localeCompare(b.slot.origin) ||
      a.slot.sourceToken.localeCompare(b.slot.sourceToken) ||
      a.slot.destination.localeCompare(b.slot.destination) ||
      a.slot.target.localeCompare(b.slot.target)
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
    origin: Math.max(6, ...toSubmit.map((r) => r.slot.origin.length)),
    src: Math.max(3, ...toSubmit.map((r) => r.slot.sourceToken.length)),
    dest: Math.max(4, ...toSubmit.map((r) => r.slot.destination.length)),
    target: Math.max(6, ...toSubmit.map((r) => r.slot.target.length)),
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
  for (const { slot, sourceBps, currentBps } of toSubmit) {
    console.log(
      `${pad(slot.origin, W.origin)}   ${pad(slot.sourceToken, W.src)} → ${pad(slot.destination, W.dest)}   ${pad(slot.target, W.target)}   ${pad(currentBps, W.cur)}   ${sourceBps}`,
    );
  }
  console.log();

  if (!propose) {
    console.log('Dry run complete. Pass --propose to submit transactions.');
    return;
  }

  // ── Sign and submit ────────────────────────────────────────────────────────

  for (const { slot, maxFee, halfAmount, sourceBps } of toSubmit) {
    const provider = multiProvider.getProvider(slot.origin);
    const signerWallet = new Wallet(signerKey, provider);
    const submitter = submitterWallet!.connect(provider);
    const { chainId } = await provider.getNetwork();

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiry = issuedAt + TTL_7D;
    const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const submitterAddr = constants.AddressZero;

    const context = ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'uint256'],
      [slot.destDomain, WILDCARD_RECIPIENT, constants.MaxUint256],
    );
    const data = ethers.utils.solidityPack(
      ['uint256', 'uint256'],
      [maxFee, halfAmount],
    );

    const signature = await signerWallet._signTypedData(
      {
        name: EIP712_NAME,
        version: EIP712_VERSION,
        chainId,
        verifyingContract: slot.oqlfAddress,
      },
      SIGNED_QUOTE_TYPES,
      { context, data, issuedAt, expiry, salt, submitter: submitterAddr },
    );

    process.stdout.write(
      `${slot.origin} (${slot.sourceToken}) → ${slot.destination} / ${slot.target} (${sourceBps} bps)... `,
    );
    const oqlf = OffchainQuotedLinearFee__factory.connect(
      slot.oqlfAddress,
      submitter,
    );
    const txOverrides = multiProvider.getTransactionOverrides(slot.origin);
    const tx = await oqlf.submitQuote(
      { context, data, issuedAt, expiry, salt, submitter: submitterAddr },
      signature,
      txOverrides,
    );
    process.stdout.write(`${tx.hash.slice(0, 14)}… `);
    await tx.wait(1);
    console.log('confirmed.');
  }

  console.log('\nAll quotes propagated.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
