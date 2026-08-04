import { JsonRpcProvider, type Log } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { execa } from 'execa';

import {
  type ForkManagerFactory,
  type ForkedChainMetadata,
  type IForkManager,
  waitUntilReady,
} from '@hyperlane-xyz/forking-sdk';
import {
  type ChainName,
  type EventAssertion,
  EventAssertionType,
  type ForkedChainConfig,
  type ForkedChainTransactionConfig,
  type MultiProvider,
  type RevertAssertion,
  TransactionDataType,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, deepEquals } from '@hyperlane-xyz/utils';

import { logGray } from '../logger.js';

const LOCAL_HOST = 'http://127.0.0.1';

export interface EvmForkManagerConfig {
  chainName: ChainName;
  chainId: string | number;
  upstreamRpcUrl: string;
  port: number;
  kill: boolean;
}

class RunningEvmFork {
  constructor(
    readonly provider: JsonRpcProvider,
    readonly endpoint: string,
    readonly kill: (isPanicking: boolean) => Promise<void>,
  ) {}
}

async function startEvmFork(
  config: EvmForkManagerConfig,
): Promise<RunningEvmFork> {
  const endpoint = `${LOCAL_HOST}:${config.port}`;
  let killOnError: ((isPanicking: boolean) => Promise<void>) | undefined;
  try {
    logGray(
      `Starting Anvil node for chain ${config.chainName} at port ${config.port}`,
    );
    const anvilProcess = execa`anvil --port ${config.port} --chain-id ${config.chainId} --fork-url ${config.upstreamRpcUrl} --disable-block-gas-limit`;

    const kill = async (isPanicking: boolean): Promise<void> => {
      anvilProcess.kill(isPanicking ? 'SIGTERM' : 'SIGINT');
    };
    killOnError = kill;

    const provider = new JsonRpcProvider(endpoint);
    await waitUntilReady(() => provider.getNetwork(), {
      attempts: 10,
      baseRetryMs: 500,
    });

    logGray(
      `Successfully started Anvil node for chain ${config.chainName} at ${endpoint}`,
    );

    process.once('exit', () => void kill(false));

    return new RunningEvmFork(provider, endpoint, kill);
  } catch (error) {
    // Kill any running anvil process otherwise the process will keep running
    // in the background.
    if (killOnError) {
      await killOnError(true);
    }

    throw error;
  }
}

export class EvmForkManager implements IForkManager<ForkedChainConfig> {
  private running?: RunningEvmFork;

  constructor(private readonly config: EvmForkManagerConfig) {}

  private get requireRunning(): RunningEvmFork {
    const running = this.running;
    assert(running, `Fork not started for chain ${this.config.chainName}`);
    return running;
  }

  async start(): Promise<void> {
    this.running = await startEvmFork(this.config);
  }

  async applyForkConfig(config: ForkedChainConfig): Promise<void> {
    const { provider, kill } = this.requireRunning;

    await handleImpersonations(
      provider,
      this.config.chainName,
      config.impersonateAccounts,
    );

    await handleTransactions(
      provider,
      this.config.chainName,
      config.transactions,
    );

    if (this.config.kill) {
      await kill(false);
    }
  }

  getForkedChainMetadata(): ForkedChainMetadata {
    return {
      rpcUrls: [{ http: this.requireRunning.endpoint }],
      blocks: { confirmations: 1 },
    };
  }

  kill(): void {
    void this.running?.kill(false);
  }
}

export function createEvmForkManagerFactory(
  multiProvider: MultiProvider,
  kill: boolean,
): ForkManagerFactory {
  return (ctx) =>
    new EvmForkManager({
      chainName: ctx.chainName,
      chainId: multiProvider.getChainMetadata(ctx.chainName).chainId,
      upstreamRpcUrl: ctx.upstreamRpcUrl,
      port: ctx.port,
      kill,
    });
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

    let pendingTx;
    try {
      pendingTx = await signer.sendTransaction({
        to: transaction.to,
        data: calldata,
        value: transaction.value,
      });
    } catch (error: unknown) {
      const reason = getRevertReason(error);
      if (reason && transaction.revertAssertion) {
        assertRevert(transaction.revertAssertion, reason, {
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
      await provider.send('evm_increaseTime', [transaction.timeSkip]);
    }

    txCounter++;
  }
  logGray(`Successfully executed all transactions on chain ${chainName}`);
}

function getRevertReason(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'reason' in error &&
    typeof error.reason === 'string'
  ) {
    return error.reason;
  }

  return undefined;
}

function assertRevert(
  revertAssertion: RevertAssertion,
  reason: string,
  meta: {
    chainName: string;
    transactionAnnotation: string;
  },
) {
  // If contract call reverts, then there should be a reason
  // https://github.com/ethers-io/ethers.js/blob/v5.7/packages/providers/src.ts/json-rpc-provider.ts#L79
  if (reason !== revertAssertion.reason) {
    throw new Error(
      `Expected revert: ${revertAssertion.reason} does not match ${reason}`,
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
