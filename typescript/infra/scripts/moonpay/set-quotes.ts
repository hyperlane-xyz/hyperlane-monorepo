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
 */

import { Wallet, constants, ethers } from 'ethers';
import yargs from 'yargs';

import { checkbox, confirm, input } from '@inquirer/prompts';

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

// ── Constants ─────────────────────────────────────────────────────────────────

const WILDCARD_DEST = 0xffffffff;
const WILDCARD_RECIPIENT = '0x' + 'ff'.repeat(32);
// keccak256("RoutingFee.DEFAULT_ROUTER")
const DEFAULT_ROUTER_KEY =
  '0x6e086cd647d6eb8b516856666e2c1465fb8a6a58d3a75938362acc674eacaf47';
const ROUTE_IDS = [WarpRouteIds.CROSSCitreaMoonpay];
const DEFAULT_TTL = 86_400; // 24 hours

// EIP-712: matches AbstractOffchainQuoter.sol name/version
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

// Matches EvmTokenFeeReader.convertFromBps — used to derive canonical (maxFee, halfAmount)
// from a bps value without needing an on-chain read.
const ASSUMED_MAX_AMOUNT = 10n ** 36n; // 10^36 — prevents overflow in LinearFee contract
const MAX_BPS = 10_000n;
const BPS_PRECISION = 10_000n; // supports up to 4 decimal places on bps

// ── Types ─────────────────────────────────────────────────────────────────────

interface OqlfSlot {
  origin: string;
  sourceToken: string; // normalised group label of the origin token (USDC / USDT)
  destination: string;
  destDomain: number;
  target: string; // "DEFAULT" or normalised group label of the destination token
  oqlfAddress: string;
  currentBpsStr: string;
  currentSource: 'standing' | 'fallback';
  onchainMaxFee: bigint;
  onchainHalfAmount: bigint;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Display bps as "W.FF" — same formula as print-quotes. */
function fmtBps(maxFee: bigint, halfAmount: bigint): string {
  if (halfAmount === 0n) return '?.??';
  const denom = halfAmount * 2n;
  const whole = (maxFee * 10_000n) / denom;
  const frac = (maxFee * 1_000_000n) / denom - whole * 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * Convert a numeric bps value to canonical (maxFee, halfAmount).
 * Mirrors EvmTokenFeeReader.convertFromBps exactly so deployed contracts
 * are consistent with the standing quote parameters.
 */
function bpsToParams(bps: number): { maxFee: bigint; halfAmount: bigint } {
  const maxFee = BigInt(constants.MaxUint256.toString()) / ASSUMED_MAX_AMOUNT;
  const scaledBps = BigInt(Math.round(bps * Number(BPS_PRECISION)));
  const halfAmount = ((maxFee / 2n) * MAX_BPS * BPS_PRECISION) / scaledBps;
  return { maxFee, halfAmount };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    registry: registryUri,
    ttl,
    submitterKey: submitterKeyArg,
  } = await yargs(process.argv.slice(2))
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://…)',
    })
    .option('ttl', {
      type: 'number',
      default: DEFAULT_TTL,
      describe: 'Standing quote TTL in seconds (default 24 h)',
    })
    .option('submitter-key', {
      alias: 'k',
      type: 'string',
      describe:
        'Private key (0x…) of the gas-paying submitter account. ' +
        'Defaults to PRIVATE_KEY env var. ' +
        'The quote signer (GCP secret) signs; this account pays gas.',
    })
    .parseAsync();

  // Signing key: GCP secret, no ETH needed — only signs the EIP-712 data.
  const secret = (await fetchGCPSecret(GCP_SIGNER_SECRET)) as {
    privateKey: string;
    address: string;
  };
  const signerKey = secret.privateKey;
  console.log(`Signer:    ${secret.address}`);

  // Submitter key: pays gas for submitQuote(). Anyone may submit since submitter=address(0).
  const submitterKeyRaw = submitterKeyArg ?? process.env.PRIVATE_KEY;
  if (!submitterKeyRaw) {
    console.error(
      'Error: provide a gas-paying key via --submitter-key or PRIVATE_KEY env var.',
    );
    process.exit(1);
  }
  const submitterKey = submitterKeyRaw.startsWith('0x')
    ? submitterKeyRaw
    : `0x${submitterKeyRaw}`;
  const submitterWallet = new Wallet(submitterKey);
  console.log(`Submitter: ${submitterWallet.address}`);

  // HTTP registry overlays private RPC URLs; filesystem registry handles warp configs.
  const rpcRegistry = registryUri
    ? getMergedRegistry({ registryUris: [registryUri], enableProxy: true })
    : getRegistry();
  const chainMetadata = await rpcRegistry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);

  // address → normalised group label: usd-coin→"USDC", tether→"USDT", else symbol.
  // EVM addresses are lowercased; non-EVM (e.g. Solana base58) are kept as-is.
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

  // ── Discover all OQLF slots ────────────────────────────────────────────────
  console.log('\nDiscovering OQLF slots (one-time RPC scan)...\n');
  const now = Math.floor(Date.now() / 1000);
  // dedup: one standing-quote storage slot per (oqlfAddress, destDomain)
  const seenSlots = new Set<string>();
  const allSlots: OqlfSlot[] = [];

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
        const normalizedOriginAddr = routerAddr.toLowerCase();
        const sourceToken =
          addrToLabel.get(normalizedOriginAddr) ?? originToken.symbol ?? origin;
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
            const targetKeys: Array<{ key: string; label: string }> = [
              { key: DEFAULT_ROUTER_KEY, label: 'DEFAULT' },
              ...destRouters.map((addr) => ({
                key: addressToBytes32(addr),
                label: addrToLabel.get(addr) ?? addr.slice(0, 10),
              })),
            ];

            await Promise.all(
              targetKeys.map(async ({ key, label }) => {
                let oqlfAddress: string;
                try {
                  oqlfAddress = await ccr.feeContracts(destDomain, key);
                } catch {
                  return;
                }
                if (!oqlfAddress || oqlfAddress === constants.AddressZero)
                  return;

                // Each (oqlfAddress, destDomain) is a unique on-chain storage slot.
                // Include sourceToken in the key because two CCRs on the same chain
                // (one USDC, one USDT) each own separate OQLF instances.
                const slotId = `${oqlfAddress.toLowerCase()}:${destDomain}:${sourceToken}`;
                if (seenSlots.has(slotId)) return;
                seenSlots.add(slotId);

                const oqlf = OffchainQuotedLinearFee__factory.connect(
                  oqlfAddress,
                  provider,
                );
                const [onchainMaxFee, onchainHalfAmount] = await Promise.all([
                  oqlf.maxFee(),
                  oqlf.halfAmount(),
                ]);

                // Resolve current standing quote (dest-specific wins over wildcard).
                let currentMaxFee = onchainMaxFee.toBigInt();
                let currentHalfAmount = onchainHalfAmount.toBigInt();
                let currentSource: 'standing' | 'fallback' = 'fallback';

                for (const { dest, recip } of [
                  { dest: destDomain, recip: WILDCARD_RECIPIENT },
                  { dest: WILDCARD_DEST, recip: WILDCARD_RECIPIENT },
                ]) {
                  const sq = await oqlf.quotes(dest, recip);
                  const expiry = Number(sq.expiry);
                  if (expiry > 0 && expiry >= now) {
                    currentMaxFee = sq.maxFee.toBigInt();
                    currentHalfAmount = sq.halfAmount.toBigInt();
                    currentSource = 'standing';
                    break;
                  }
                }

                allSlots.push({
                  origin,
                  sourceToken,
                  destination,
                  destDomain,
                  target: label,
                  oqlfAddress,
                  currentBpsStr: fmtBps(currentMaxFee, currentHalfAmount),
                  currentSource,
                  onchainMaxFee: onchainMaxFee.toBigInt(),
                  onchainHalfAmount: onchainHalfAmount.toBigInt(),
                });
              }),
            );
          }),
        );
      });
    }),
  );

  // Consistent ordering: origin → sourceToken → dest → DEFAULT first, then alpha by target.
  allSlots.sort((a, b) => {
    const cmp =
      a.origin.localeCompare(b.origin) ||
      a.sourceToken.localeCompare(b.sourceToken) ||
      a.destination.localeCompare(b.destination);
    if (cmp !== 0) return cmp;
    if (a.target === 'DEFAULT') return -1;
    if (b.target === 'DEFAULT') return 1;
    return a.target.localeCompare(b.target);
  });

  console.log(`Found ${allSlots.length} OQLF slots.\n`);

  // ── Verify signer authorization ────────────────────────────────────────────
  const signerAddress = secret.address;
  const sampleSlot = allSlots[0];
  if (sampleSlot) {
    const provider = multiProvider.getProvider(sampleSlot.origin);
    const oqlf = OffchainQuotedLinearFee__factory.connect(
      sampleSlot.oqlfAddress,
      provider,
    );
    const authorized = await oqlf.isQuoteSigner(signerAddress);
    if (!authorized) {
      const authorizedSigners = await oqlf.quoteSigners();
      console.error(
        `\nError: signer ${signerAddress} is NOT authorized on OQLF ${sampleSlot.oqlfAddress}.`,
      );
      console.error(
        authorizedSigners.length === 0
          ? 'No authorized signers found — contract may not be configured.'
          : `Authorized signers: ${authorizedSigners.join(', ')}`,
      );
      process.exit(1);
    }
    console.log(`Signer ${signerAddress} is authorized. Proceeding.\n`);
  }

  // ── Interactive selection ──────────────────────────────────────────────────

  const parseTtl = (v: string): number | null => {
    const t = v.trim().toLowerCase();
    const m = t.match(/^(\d+(?:\.\d+)?)(h|d)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return m[2] === 'd' ? n * 86_400 : n * 3600;
  };

  const defaultTtlStr =
    ttl % 86_400 === 0 ? `${ttl / 86_400}d` : `${ttl / 3600}h`;
  const ttlRaw = await input({
    message: 'Standing quote TTL (e.g. 24h or 2d)',
    default: defaultTtlStr,
    validate: (v) => parseTtl(v) !== null || 'Enter a duration like 24h or 2d.',
  });
  const effectiveTtl = parseTtl(ttlRaw)!;

  const availableOrigins = [...new Set(allSlots.map((s) => s.origin))].sort();
  const selectedChains = await checkbox({
    message: 'Select origin chains',
    choices: availableOrigins.map((c) => ({ value: c })),
    pageSize: 20,
    required: true,
  });

  const availableSourceTokens = [
    ...new Set(allSlots.map((s) => s.sourceToken)),
  ].sort();
  const selectedSourceTokens = await checkbox({
    message: 'Select source token groups',
    choices: availableSourceTokens.map((t) => ({ value: t })),
    pageSize: 20,
    required: true,
  });

  const availableDestinations = [
    ...new Set(allSlots.map((s) => s.destination)),
  ].sort();
  const selectedDestinations = await checkbox({
    message: 'Select destination chains',
    choices: availableDestinations.map((c) => ({ value: c })),
    pageSize: 20,
    required: true,
  });

  const availableTargets = [...new Set(allSlots.map((s) => s.target))].sort(
    (a, b) => {
      if (a === 'DEFAULT') return -1;
      if (b === 'DEFAULT') return 1;
      return a.localeCompare(b);
    },
  );
  const selectedTargets = await checkbox({
    message: 'Select target token groups',
    choices: availableTargets.map((t) => ({ value: t })),
    pageSize: 20,
    required: true,
  });

  const filteredSlots = allSlots.filter(
    (s) =>
      selectedChains.includes(s.origin) &&
      selectedSourceTokens.includes(s.sourceToken) &&
      selectedDestinations.includes(s.destination) &&
      selectedTargets.includes(s.target),
  );

  console.log(
    `\n${filteredSlots.length} combination(s) to review.\n` +
      'For each: enter bps, ↵ skip, "d" for on-chain default.\n',
  );

  // ── Per-slot prompts ───────────────────────────────────────────────────────

  const toSubmit: Array<{
    slot: OqlfSlot;
    maxFee: bigint;
    halfAmount: bigint;
    newBpsStr: string;
  }> = [];

  for (const slot of filteredSlots) {
    const fallbackBpsStr = fmtBps(slot.onchainMaxFee, slot.onchainHalfAmount);
    const effectiveLine =
      slot.currentSource === 'standing'
        ? `  effective : ${slot.currentBpsStr} bps (standing quote — overrides fallback)`
        : `  effective : ${slot.currentBpsStr} bps (no standing quote, using fallback)`;
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
        const n = parseFloat(t);
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
      ({ maxFee, halfAmount } = bpsToParams(parseFloat(trimmed)));
      newBpsStr = fmtBps(maxFee, halfAmount);
    }

    console.log(`  → queued: ${newBpsStr} bps`);
    toSubmit.push({ slot, maxFee, halfAmount, newBpsStr });
  }

  if (toSubmit.length === 0) {
    console.log('\nNothing to submit.');
    return;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────

  const ttlHours = (effectiveTtl / 3600).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${toSubmit.length} quote(s) to submit (TTL ${ttlHours} h):`);
  for (const { slot, newBpsStr } of toSubmit) {
    console.log(
      `  ${slot.origin} (${slot.sourceToken}) → ${slot.destination}  /  ${slot.target}  →  ${newBpsStr} bps`,
    );
  }
  console.log('═'.repeat(60));

  const confirmed = await confirm({ message: 'Submit?', default: false });
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  // ── Sign and submit ────────────────────────────────────────────────────────

  for (const { slot, maxFee, halfAmount, newBpsStr } of toSubmit) {
    const provider = multiProvider.getProvider(slot.origin);
    // signerWallet: signs the EIP-712 data (no gas needed).
    const signerWallet = new Wallet(signerKey, provider);
    // submitter: connected to provider so it can pay gas.
    const submitter_wallet = submitterWallet.connect(provider);
    const { chainId } = await provider.getNetwork();

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiry = issuedAt + effectiveTtl;
    const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const submitter = constants.AddressZero; // unrestricted for standing quotes

    // FeeQuoteContext.encode(destDomain, WILDCARD_RECIPIENT, WILDCARD_AMOUNT)
    const context = ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'uint256'],
      [slot.destDomain, WILDCARD_RECIPIENT, constants.MaxUint256],
    );
    // FeeQuoteData.encode(maxFee, halfAmount)
    const data = ethers.utils.solidityPack(
      ['uint256', 'uint256'],
      [maxFee, halfAmount],
    );

    const domain = {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: slot.oqlfAddress,
    };
    const message = { context, data, issuedAt, expiry, salt, submitter };
    const signature = await signerWallet._signTypedData(
      domain,
      SIGNED_QUOTE_TYPES,
      message,
    );

    process.stdout.write(
      `Submitting ${slot.origin} (${slot.sourceToken}) → ${slot.destination} / ${slot.target} (${newBpsStr} bps)... `,
    );
    // Submitter wallet pays gas; anyone may submit since submitter field = address(0).
    const oqlf = OffchainQuotedLinearFee__factory.connect(
      slot.oqlfAddress,
      submitter_wallet,
    );
    const txOverrides = multiProvider.getTransactionOverrides(slot.origin);
    const tx = await oqlf.submitQuote(
      { context, data, issuedAt, expiry, salt, submitter },
      signature,
      txOverrides,
    );
    process.stdout.write(`${tx.hash.slice(0, 14)}… `);
    await tx.wait(1);
    console.log('confirmed.');
  }

  console.log('\nAll quotes submitted.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
