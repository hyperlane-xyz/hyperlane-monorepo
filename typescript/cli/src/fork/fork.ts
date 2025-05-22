import { JsonRpcProvider, Log } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { execa } from 'execa';

import {
  ChainName,
  EventAssertion,
  EventAssertionType,
  ForkedChainConfig,
  ForkedChainTransactionConfig,
  MultiProvider,
  RawForkedChainConfigByChain,
  TransactionDataType,
  forkedChainConfigByChainFromRaw,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  deepEquals,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

const LOCAL_HOST = 'http://127.0.0.1';

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
  const filteredChainsToFork = Array.from(chainsToFork).filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );

  let port = basePort;
  const parsedForkConfig = forkedChainConfigByChainFromRaw(
    forkConfig,
    readYamlOrJson,
  );
  for (const chainName of filteredChainsToFork) {
    await forkChain(
      context.multiProvider,
      chainName,
      port,
      kill,
      parsedForkConfig[chainName],
    );

    port++;
  }
}

async function forkChain(
  multiProvider: MultiProvider<{}>,
  chainName: ChainName,
  forkPort: number,
  kill: boolean,
  forkConfig?: ForkedChainConfig,
): Promise<void> {
  let killAnvilProcess: ((isPanicking: boolean) => Promise<void>) | undefined;
  try {
    const chainMetadata = await multiProvider.getChainMetadata(chainName);

    const rpcUrl = chainMetadata.rpcUrls[0];
    if (!rpcUrl) {
      logRed(`No rpc found for chain ${chainName}`);
      process.exit(0);
    }

    const endpoint = `${LOCAL_HOST}:${forkPort}`;
    logGray(`Starting Anvil node for chain ${chainName} at port ${forkPort}`);
    const anvilProcess = execa`anvil --port ${forkPort} --chain-id ${chainMetadata.chainId} --fork-url ${rpcUrl.http} --disable-block-gas-limit`;

    const provider = new JsonRpcProvider(endpoint);
    await retryAsync(() => provider.getNetwork(), 10, 500);

    logGray(
      `Successfully started Anvil node for chain ${chainName} at ${endpoint}`,
    );

    killAnvilProcess = async (isPanicking: boolean) => {
      anvilProcess.kill(isPanicking ? 'SIGTERM' : 'SIGINT');
    };
    process.once('exit', () => killAnvilProcess && killAnvilProcess(false));

    if (!forkConfig) {
      return;
    }

    await handleImpersonations(
      provider,
      chainName,
      forkConfig.impersonateAccounts,
    );

    await handleTransactions(provider, chainName, forkConfig.transactions);

    if (kill) {
      await killAnvilProcess(false);
    }
  } catch (error) {
    // Kill any running anvil process otherwise the process will keep running
    // in the background.
    if (killAnvilProcess) {
      await killAnvilProcess(true);
    }

    throw error;
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
  transactions: ReadonlyArray<ForkedChainTransactionConfig>,
): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  logGray(`Executing transactions on chain ${chainName}`);
  let txCounter = 0;
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

    const annotation = transaction.annotation ?? `#${txCounter}`;
    logGray(`Executing transaction on chain ${chainName}: "${annotation}"`);
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
      await provider.send('evm_increaseTime', [transaction.timeSkip]);
    }

    txCounter++;
  }
  logGray(`Successfully executed all transactions on chain ${chainName}`);
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
