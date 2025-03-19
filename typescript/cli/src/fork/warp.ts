import { JsonRpcProvider } from '@ethersproject/providers';
import { z } from 'zod';
import { $ } from 'zx';

import {
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
  ZHash,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, retryAsync } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';

const LOCAL_HOST = 'http://127.0.0.1';

enum EventAssertionType {
  RAW_TOPIC = 'rawTopic',
  TOPIC_SIGNATURE = 'topicSignature',
}

export const EventAssertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(EventAssertionType.RAW_TOPIC),
    topic: ZHash,
  }),
  z.object({
    type: z.literal(EventAssertionType.TOPIC_SIGNATURE),
    signature: z.string(),
  }),
]);

export type EventAssertion = z.infer<typeof EventAssertionSchema>;

export const ForkedChainConfigSchema = z.object({
  impersonateAccounts: z.array(ZHash).default([]),
  transactions: z
    .array(
      z.object({
        annotation: z.string().optional(),
        from: ZHash,
        data: ZHash.optional(),
        value: z.string().optional(),
        to: ZHash.optional(),
        eventAssertions: z.array(EventAssertionSchema).default([]),
      }),
    )
    .default([]),
});

export type ForkedChainConfig = z.infer<typeof ForkedChainConfigSchema>;

export const ForkedChainConfigByChainSchema = z.record(ForkedChainConfigSchema);

export type ForkedChainConfigByChain = z.infer<
  typeof ForkedChainConfigByChainSchema
>;

export async function runWarpFork({
  context,
  core,
  deployConfig,
  forkConfig,
}: {
  context: CommandContext;
  core: WarpCoreConfig;
  forkConfig: ForkedChainConfigByChain;
  deployConfig: WarpRouteDeployConfigMailboxRequired;
}): Promise<void> {
  const chainsToFork = new Set([
    ...core.tokens.map((tokenConfig) => tokenConfig.chainName),
    ...Object.keys(deployConfig),
  ]);

  const filteredChainsToFork = Array.from(chainsToFork).filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );

  let port = 8545;
  for (const chainName of filteredChainsToFork) {
    const chainMetadata = await context.multiProvider.getChainMetadata(
      chainName,
    );

    const rpcUrl = chainMetadata.rpcUrls[0];

    if (!rpcUrl) {
      logRed(`Please specify either a symbol or warp config`);
      process.exit(0);
    }

    const endpoint = `${LOCAL_HOST}:${port}`;
    logGray(`Starting Anvil node for chain ${chainName} at port ${port}`);
    const anvilProcess = $`anvil --port ${port} --chain-id ${chainMetadata.chainId} --fork-url ${rpcUrl.http}`;

    const provider = new JsonRpcProvider(endpoint);
    await retryAsync(() => provider.getNetwork(), 10, 500);

    logGray(`Running Anvil node for chain ${chainName} at ${endpoint}`);

    process.once('exit', () => anvilProcess.kill());
    port++;

    const currentChainForkConfig = forkConfig[chainName];
    if (!currentChainForkConfig) {
      continue;
    }

    if (currentChainForkConfig.impersonateAccounts.length !== 0) {
      logGray(
        `Impersonating accounts ${currentChainForkConfig.impersonateAccounts} on chain ${chainName}`,
      );
      await Promise.all(
        currentChainForkConfig.impersonateAccounts.map((address) =>
          provider.send('anvil_impersonateAccount', [address]),
        ),
      );
    }

    if (currentChainForkConfig.transactions.length !== 0) {
      logGray(`Executing transactions on chain ${chainName}`);
      for (const transaction of currentChainForkConfig.transactions) {
        const signer = provider.getSigner(transaction.from);

        await provider.send('anvil_setBalance', [
          transaction.from,
          '10000000000000000000',
        ]);

        const pendingTx = await signer.sendTransaction({
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        });

        const txReceipt = await pendingTx.wait();

        if (txReceipt.status == 0) {
          throw new Error(
            `Transaction ${transaction} reverted on chain ${chainName}`,
          );
        }

        console.log(txReceipt);

        console.log(txReceipt.logs);
      }
      logGray(`Successfully executed all transactions on chain ${chainName}`);
    }
  }
}
