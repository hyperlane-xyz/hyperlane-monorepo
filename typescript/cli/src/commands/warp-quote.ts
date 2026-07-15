import { stringify as yamlStringify } from 'yaml';
import { type CommandModule } from 'yargs';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  type CommandModuleWithContext,
  type CommandModuleWithWriteContext,
} from '../context/types.js';
import { runWarpQuoteCreate } from '../deploy/warp-quote.js';
import { log, logCommandHeader, logGreen, warnYellow } from '../logger.js';
import { runWarpQuoteRead } from '../read/warp-quote.js';
import { ENV } from '../utils/env.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  chainCommandOption,
  outputFileCommandOption,
  stringArrayOptionConfig,
  warpRouteIdCommandOption,
} from './options.js';

const create: CommandModuleWithWriteContext<{
  warpRouteId: string;
  chain: string;
  destination: string;
  recipient: string;
  amount: string;
  maxFee: string;
  halfAmount: string;
  ttl: number;
  quoteSignerKey: string;
}> = {
  command: 'create',
  describe:
    'Submit an offchain-signed standing warp fee quote to a deployed warp route (--ttl in seconds, must be > 0)',
  builder: {
    'warp-route-id': { ...warpRouteIdCommandOption, demandOption: true },
    chain: { ...chainCommandOption, demandOption: true },
    destination: {
      type: 'string',
      description:
        'Remote chain name this quote applies to. The target router for cross-collateral fees is resolved from the warp config.',
      demandOption: true,
    },
    recipient: {
      type: 'string',
      description:
        "Recipient in the destination chain's native address format (e.g. 0x… for EVM, base58 for Solana), or `wildcard` for any recipient",
      demandOption: true,
    },
    amount: {
      type: 'string',
      description:
        'Transfer amount the quote applies to, or `wildcard` (required for standing quotes)',
      demandOption: true,
    },
    'max-fee': {
      type: 'string',
      description: 'Linear fee curve `maxFee` parameter (wei/lamports)',
      demandOption: true,
    },
    'half-amount': {
      type: 'string',
      description: 'Linear fee curve `halfAmount` parameter (wei/lamports)',
      demandOption: true,
    },
    ttl: {
      type: 'number',
      description:
        'Time-to-live in seconds for the standing quote (expiry = now + ttl). Must be > 0 — transient quotes (ttl=0) are not usable from this standalone command because their on-chain storage is scoped to the create tx (EIP-1153 on EVM, payer-scoped PDA on SVM).',
      demandOption: true,
    },
    'quote-signer-key': {
      type: 'string',
      description:
        '0x-hex secp256k1 private key for signing the quote, or use the HYP_QUOTE_SIGNER_KEY env var (distinct from --key.<protocol> which signs the submission tx)',
      default: ENV.HYP_QUOTE_SIGNER_KEY,
      defaultDescription: 'process.env.HYP_QUOTE_SIGNER_KEY',
      demandOption: true,
    },
  },
  handler: async ({
    context,
    warpRouteId,
    chain,
    destination,
    recipient,
    amount,
    maxFee,
    halfAmount,
    ttl,
    quoteSignerKey,
  }) => {
    logCommandHeader('Hyperlane Warp Quote Create');
    await runWarpQuoteCreate({
      context,
      warpRouteId,
      chain,
      destination,
      recipient,
      amount,
      maxFee,
      halfAmount,
      ttl,
      quoteSignerKey,
    });
    process.exit(0);
  },
};

const read: CommandModuleWithContext<{
  warpRouteId: string;
  chain?: string;
  recipients?: string[];
  out?: string;
}> = {
  command: 'read',
  describe:
    'Read standing offchain-signed warp fee quotes from a deployed warp route',
  builder: {
    'warp-route-id': { ...warpRouteIdCommandOption, demandOption: true },
    chain: {
      ...chainCommandOption,
      demandOption: false,
      describe:
        'Limit the read to a single chain. Defaults to every chain in the warp route.',
    },
    recipients: stringArrayOptionConfig({
      description:
        "Recipient addresses in each destination chain's native format (e.g. 0x… for EVM, base58 for Solana) to additionally probe on protocols whose standing-quote storage is non-enumerable (e.g. EVM). The CLI auto-detects protocol from the address format and converts to bytes32. Ignored on protocols that enumerate recipients on-chain (e.g. SVM).",
    }),
    out: outputFileCommandOption(),
  },
  handler: async ({ context, warpRouteId, chain, recipients, out }) => {
    logCommandHeader('Hyperlane Warp Quote Read');
    // `addressToBytes32` auto-detects protocol from the address format
    // (EVM 0x-hex, Sealevel base58, etc.), so the CLI can convert here
    // without knowing the per-destination protocols of the warp route.
    const extraRecipients = new Set<string>();
    for (const native of recipients ?? []) {
      try {
        extraRecipients.add(addressToBytes32(native));
      } catch {
        // skip inputs that don't validate as any supported protocol address
        warnYellow(
          `Skipping --recipients entry "${native}" — not a valid EVM or Sealevel address`,
        );
      }
    }
    const result = await runWarpQuoteRead({
      context,
      warpRouteId,
      chain,
      extraRecipients,
    });
    if (out) {
      writeYamlOrJson(out, result, 'yaml');
      logGreen(`Quotes written to ${out}`);
    } else {
      log(indentYamlOrJson(yamlStringify(result, null, 2), 4));
    }
    process.exit(0);
  },
};

export const quoteCommand: CommandModule = {
  command: 'quote',
  describe: 'Manage offchain-signed warp fee quotes on a deployed warp route',
  builder: (yargs) =>
    yargs.command(create).command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};
