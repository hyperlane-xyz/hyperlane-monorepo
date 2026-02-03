import { type Log } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
  type EventAssertion,
  EventAssertionType,
  type ForkedChainConfig,
  type ForkedChainTransactionConfig,
  type MultiProvider,
  type RawForkedChainConfigByChain,
  type RevertAssertion,
  TransactionDataType,
  forkedChainConfigByChainFromRaw,
  impersonateAccounts,
  increaseTime,
  setBalance,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  assert,
  deepEquals,
} from '@hyperlane-xyz/utils';
import { forkChain as forkChainBase } from '@hyperlane-xyz/utils/anvil';

import { type CommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

type EndPoint = string;

export async function runForkCommand({
  context,
  chainsToFork,
  forkConfig,
  kill,
  basePort = 8545,
}: {
  context: CommandContext;
  chainsToFork: Set<ChainName>;
  forkConfig: RawForkedChainConfigByChain;
  kill: boolean;
  basePort?: number;
}): Promise<void> {
  const { registry } = context;
  const filteredChainsToFork = Array.from(chainsToFork).filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );

  let port = basePort;
  const parsedForkConfig = forkedChainConfigByChainFromRaw(
    forkConfig,
    readYamlOrJson,
  );
  const chainMetadataOverrides: ChainMap<{
    blocks: ChainMetadata['blocks'];
    rpcUrls: ChainMetadata['rpcUrls'];
  }> = {};
  for (const chainName of filteredChainsToFork) {
    const endpoint = await forkChain(
      context.multiProvider,
      chainName,
      port,
      kill,
      parsedForkConfig[chainName],
    );
    chainMetadataOverrides[chainName] = {
      blocks: { confirmations: 1 },
      rpcUrls: [{ http: endpoint }],
    };

    port++;
  }

  const mergedRegistry = new MergedRegistry({
    registries: [
      registry,
      new PartialRegistry({ chainMetadata: chainMetadataOverrides }),
    ],
  });
  const httpServerPort = basePort - 10;
  assert(
    httpServerPort > 0,
    'HTTP server port too low, consider increasing --port',
  );

  const httpRegistryServer = await HttpServer.create(
    async () => mergedRegistry,
  );
  await httpRegistryServer.start(httpServerPort.toString());
}

async function forkChain(
  multiProvider: MultiProvider<{}>,
  chainName: ChainName,
  forkPort: number,
  kill: boolean,
  forkConfig?: ForkedChainConfig,
): Promise<EndPoint> {
  let killAnvilProcess: ((isPanicking: boolean) => void) | undefined;
  try {
    const chainMetadata = await multiProvider.getChainMetadata(chainName);

    const rpcUrl = chainMetadata.rpcUrls[0];
    if (!rpcUrl) {
      logRed(`No rpc found for chain ${chainName}`);
      process.exit(1);
    }

    logGray(`Starting Anvil node for chain ${chainName} at port ${forkPort}`);

    const fork = await forkChainBase({
      rpcUrl: rpcUrl.http,
      chainId: Number(chainMetadata.chainId),
      port: forkPort,
    });

    logGray(
      `Successfully started Anvil node for chain ${chainName} at ${fork.endpoint}`,
    );

    killAnvilProcess = (isPanicking: boolean) => {
      fork.kill(isPanicking);
    };
    process.once('exit', () => killAnvilProcess && killAnvilProcess(false));

    if (!forkConfig) {
      return fork.endpoint;
    }

    await handleImpersonations(
      fork.provider,
      chainName,
      forkConfig.impersonateAccounts,
    );

    await handleTransactions(fork.provider, chainName, forkConfig.transactions);

    if (kill) {
      killAnvilProcess(false);
    }

    return fork.endpoint;
  } catch (error) {
    if (killAnvilProcess) {
      killAnvilProcess(true);
    }

    throw error;
  }
}

async function handleImpersonations(
  provider: ethers.providers.JsonRpcProvider,
  chainName: ChainName,
  accountsToImpersonate: Address[],
): Promise<void> {
  if (accountsToImpersonate.length === 0) {
    return;
  }

  logGray(
    `Impersonating accounts ${accountsToImpersonate} on chain ${chainName}`,
  );
  await impersonateAccounts(provider, accountsToImpersonate);
}

async function handleTransactions(
  provider: ethers.providers.JsonRpcProvider,
  chainName: ChainName,
  transactions: ReadonlyArray<ForkedChainTransactionConfig>,
): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  logGray(`Executing transactions on chain ${chainName}`);
  let txCounter = 0;
  for (const transaction of transactions) {
    const signer = provider.getSigner(transaction.from);

    await setBalance(provider, transaction.from, '0x8AC7230489E80000');

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

    const annotation = transaction.annotation ?? `#${txCounter}`;
    logGray(`Executing transaction on chain ${chainName}: "${annotation}"`);

    let pendingTx;
    try {
      pendingTx = await signer.sendTransaction({
        to: transaction.to,
        data: calldata,
        value: transaction.value,
      });
    } catch (error: any) {
      if (error.reason && transaction.revertAssertion) {
        assertRevert(transaction.revertAssertion, error, {
          chainName: chainName,
          transactionAnnotation: annotation,
        });
        continue;
      }

      // New unhandled error
      throw error;
    }

    const txReceipt = await pendingTx.wait();
    if (txReceipt.status == 0) {
      throw new Error(
        `Transaction ${transaction} reverted on chain ${chainName}`,
      );
    }

    transaction.eventAssertions.forEach((eventAssertion, idx) =>
      assertEvent(eventAssertion, txReceipt.logs, {
        chainName: chainName,
        assertionIdx: idx,
        transactionAnnotation: annotation,
      }),
    );

    if (transaction.timeSkip) {
      logGray(
        `Forwarding time by "${transaction.timeSkip}" seconds on chain ${chainName}`,
      );
      await increaseTime(provider, transaction.timeSkip);
    }

    txCounter++;
  }
  logGray(`Successfully executed all transactions on chain ${chainName}`);
}

function assertRevert(
  revertAssertion: RevertAssertion,
  error: any,
  meta: {
    chainName: string;
    transactionAnnotation: string;
  },
) {
  // If contract call reverts, then there should be a reason
  // https://github.com/ethers-io/ethers.js/blob/v5.7/packages/providers/src.ts/json-rpc-provider.ts#L79
  if (error.reason !== revertAssertion.reason) {
    throw new Error(
      `Expected revert: ${revertAssertion.reason} does not match ${error.reason}`,
    );
  }

  const annotation = revertAssertion.annotation ?? revertAssertion.type;
  logGray(
    `Successfully completed revert assertion on chain "${meta.chainName}" and transaction "${meta.transactionAnnotation}": "${annotation}"`,
  );
}

function assertEvent(
  eventAssertion: EventAssertion,
  rawLogs: Log[],
  meta: {
    chainName: string;
    assertionIdx: number;
    transactionAnnotation: string;
  },
): void {
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

  const annotation = eventAssertion.annotation ?? `#${meta.assertionIdx}`;
  logGray(
    `Successfully completed assertion on chain "${meta.chainName}" and transaction "${meta.transactionAnnotation}": "${annotation}"`,
  );
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
