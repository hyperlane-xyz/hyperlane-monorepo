import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { FeeQuotingServer } from '../FeeQuotingServer.js';
import { ServerConfigSchema } from '../src/config.js';

process.on('uncaughtException', (err) => {
  rootLogger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  rootLogger.error({ reason }, 'Unhandled rejection');
  process.exit(1);
});

async function main() {
  const args = await yargs(hideBin(process.argv))
    .option('signer-key', {
      alias: 'k',
      describe: 'Private key for EIP-712 quote signing (hex)',
      type: 'string',
      default: process.env.SIGNER_PRIVATE_KEY,
    })
    .option('warp-route-ids', {
      alias: 'w',
      describe: 'Comma-separated warp route IDs from the registry',
      type: 'string',
      default: process.env.WARP_ROUTE_IDS,
    })
    .option('registry', {
      alias: 'r',
      describe: 'Registry URI (local path or URL)',
      type: 'string',
      default: process.env.REGISTRY_URI,
      demandOption: true,
    })
    .option('api-keys', {
      alias: 'a',
      describe: 'Comma-separated API keys for authentication',
      type: 'string',
      default: process.env.API_KEYS,
    })
    .option('port', {
      alias: 'p',
      describe: 'Port to run the server on',
      type: 'number',
      default: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
    })
    .option('quote-mode', {
      alias: 'm',
      describe:
        'Quote mode: transient (single-use via QuotedCalls) or standing (reusable)',
      type: 'string',
      default: process.env.QUOTE_MODE ?? 'transient',
    })
    .option('quote-expiry', {
      alias: 'e',
      describe: 'Quote TTL in seconds (standing mode only)',
      type: 'number',
      default: process.env.QUOTE_EXPIRY
        ? parseInt(process.env.QUOTE_EXPIRY, 10)
        : undefined,
    })
    .help()
    .parse();

  const config = ServerConfigSchema.parse({
    signerKey: args['signer-key'],
    warpRouteIds: args['warp-route-ids']?.split(',').map((k) => k.trim()) ?? [],
    registryUri: args.registry,
    apiKeys: args['api-keys']?.split(',').map((k) => k.trim()) ?? [],
    port: args.port,
    quoteMode: args['quote-mode'],
    quoteExpiry: args['quote-expiry'],
  });

  rootLogger.info(
    `Starting fee quoting server for warp routes: ${config.warpRouteIds.join(', ')}`,
  );

  const registry: IRegistry = getRegistry({
    registryUris: [config.registryUri],
    enableProxy: true,
    logger: rootLogger,
  });

  const server = await FeeQuotingServer.create(config);
  await server.start(registry);
}

main().catch((err) => {
  rootLogger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
