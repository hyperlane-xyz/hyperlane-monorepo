import { JsonRpcProvider, Log } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { z } from 'zod';
import { $ } from 'zx';

import {
  ChainName,
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
  ZHash,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  deepEquals,
  retryAsync,
} from '@hyperlane-xyz/utils';

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
    args: z.array(z.string()).optional(),
  }),
]);

export type EventAssertion = z.infer<typeof EventAssertionSchema>;

enum TransactionDataType {
  RAW_CALLDATA = 'rawCalldata',
  SIGNATURE = 'signature',
}

const TransactionDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TransactionDataType.RAW_CALLDATA),
    calldata: ZHash,
  }),
  z.object({
    type: z.literal(TransactionDataType.SIGNATURE),
    signature: z.string(),
    args: z.array(z.string()).default([]),
  }),
]);

export const ForkedChainConfigSchema = z.object({
  impersonateAccounts: z.array(ZHash).default([]),
  transactions: z
    .array(
      z.object({
        annotation: z.string().optional(),
        from: ZHash,
        data: TransactionDataSchema.optional(),
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
      logRed(`No rpc found for chain ${chainName}`);
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

    await handleImpersonations(
      provider,
      chainName,
      currentChainForkConfig.impersonateAccounts,
    );

    await handleTransactions(
      provider,
      chainName,
      currentChainForkConfig.transactions,
    );
  }
}

async function handleImpersonations(
  provider: JsonRpcProvider,
  chainName: ChainName,
  accountsToImpersonate: Address[],
): Promise<void> {
  if (accountsToImpersonate.length === 0) {
    return;
  }

  logGray(
    `Impersonating accounts ${accountsToImpersonate} on chain ${chainName}`,
  );
  await Promise.all(
    accountsToImpersonate.map((address) =>
      provider.send('anvil_impersonateAccount', [address]),
    ),
  );
}

async function handleTransactions(
  provider: JsonRpcProvider,
  chainName: ChainName,
  transactions: ForkedChainConfig['transactions'],
): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  logGray(`Executing transactions on chain ${chainName}`);
  for (const transaction of transactions) {
    const signer = provider.getSigner(transaction.from);

    await provider.send('anvil_setBalance', [
      transaction.from,
      '10000000000000000000',
    ]);

    let calldata: string | undefined;
    if (transaction.data?.type === TransactionDataType.RAW_CALLDATA) {
      calldata = transaction.data.calldata;
    } else if (transaction.data?.type === TransactionDataType.SIGNATURE) {
      const functionInterface = new ethers.utils.Interface([
        transaction.data.signature,
      ]);

      const [functionName] = Object.keys(functionInterface.functions);
      calldata = functionInterface.encodeFunctionData(
        functionName,
        transaction.data.args,
      );
    }

    logGray(
      `Executing transaction on chain ${chainName}: "${transaction.annotation}" `,
    );
    const pendingTx = await signer.sendTransaction({
      to: transaction.to,
      data: calldata,
      value: transaction.value,
    });

    const txReceipt = await pendingTx.wait();
    if (txReceipt.status == 0) {
      throw new Error(
        `Transaction ${transaction} reverted on chain ${chainName}`,
      );
    }

    transaction.eventAssertions.forEach((eventAssertion) =>
      assertEvent(eventAssertion, txReceipt.logs),
    );
  }
  logGray(`Successfully executed all transactions on chain ${chainName}`);
}

function assertEvent(eventAssertion: EventAssertion, rawLogs: Log[]): void {
  const [rawLog] = rawLogs.filter((rawLog) =>
    eventAssertion.type === EventAssertionType.RAW_TOPIC
      ? assertEventByTopic(eventAssertion, rawLog)
      : assertEventBySignature(eventAssertion, rawLog),
  );

  if (!rawLog) {
    throw new Error(
      `Log ${
        eventAssertion.type === EventAssertionType.RAW_TOPIC
          ? eventAssertion.topic
          : eventAssertion.signature
      } not found in transaction!`,
    );
  }
}

function assertEventByTopic(
  eventAssertion: Extract<
    EventAssertion,
    { type: EventAssertionType.RAW_TOPIC }
  >,
  rawLog: ethers.providers.Log,
): boolean {
  return rawLog.topics[0] === eventAssertion.topic;
}

function assertEventBySignature(
  eventAssertion: Extract<
    EventAssertion,
    { type: EventAssertionType.TOPIC_SIGNATURE }
  >,
  rawLog: ethers.providers.Log,
): boolean {
  const eventInterface = new ethers.utils.Interface([eventAssertion.signature]);

  let parsedLog: ethers.utils.LogDescription;
  // parseLog throws if the event cannot be decoded
  try {
    parsedLog = eventInterface.parseLog(rawLog);

    if (!parsedLog) {
      return false;
    }
  } catch {
    return false;
  }

  if (!eventAssertion.args) {
    return true;
  }

  const logArgs = parsedLog.args
    .slice(0, eventAssertion.args.length)
    .map((arg) => String(arg));

  return deepEquals(logArgs, eventAssertion.args);
}
