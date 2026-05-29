import { type CommandModule } from 'yargs';

import { type CommandModuleWithWriteContext } from '../context/types.js';
import { runWarpQuoteCreate } from '../deploy/warp-quote.js';
import { log, logCommandHeader } from '../logger.js';

import { chainCommandOption, warpRouteIdCommandOption } from './options.js';

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
    'Submit an offchain-signed warp fee quote (transient with --ttl=0, standing otherwise) to a deployed warp route',
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
        'Time-to-live in seconds. `ttl=0` ⇒ transient quote; `ttl>0` ⇒ standing quote (expiry = now + ttl).',
      demandOption: true,
    },
    'quote-signer-key': {
      type: 'string',
      description:
        '0x-hex secp256k1 private key for signing the quote (distinct from --key.<protocol> which signs the submission tx)',
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

export const quoteCommand: CommandModule = {
  command: 'quote',
  describe: 'Manage offchain-signed warp fee quotes on a deployed warp route',
  builder: (yargs) => yargs.command(create).version(false).demandCommand(),
  handler: () => log('Command required'),
};
