import { JsonRpcProvider, type Log } from '@ethersproject/providers';
import { ethers } from 'ethers';
import { execa } from 'execa';
import { createServer } from 'node:net';

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
import {
  type Address,
  assert,
  deepEquals,
  timeout,
} from '@hyperlane-xyz/utils';

import { logDebug, logGray } from '../logger.js';

const LOCAL_HOST = 'http://127.0.0.1';

// Per-probe RPC timeout so a single hung request fails fast and the bounded
// readiness loop can continue.
const RPC_PROBE_TIMEOUT_MS = 5000;

export interface EvmForkManagerConfig {
  chainName: ChainName;
  chainId: string | number;
  upstreamRpcUrl: string;
  port: number;
}

class RunningEvmFork {
  constructor(
    readonly provider: JsonRpcProvider,
    readonly endpoint: string,
    readonly kill: (isPanicking: boolean) => Promise<void>,
  ) {}
}

/**
 * Minimal handle the fork logic needs from a spawned anvil child. Satisfied by
 * execa's return value; the tests inject a fake to drive the exit race without a
 * live anvil.
 */
export interface AnvilProcessHandle extends Promise<unknown> {
  kill(signal: 'SIGTERM' | 'SIGINT'): void;
}

type SpawnAnvil = (config: EvmForkManagerConfig) => AnvilProcessHandle;

export type WaitForEvmRpcReady = (
  provider: JsonRpcProvider,
  signal: AbortSignal,
) => Promise<void>;

interface StartEvmForkDeps {
  spawnAnvil: SpawnAnvil;
  waitForReady: WaitForEvmRpcReady;
}

function defaultSpawnAnvil(config: EvmForkManagerConfig): AnvilProcessHandle {
  return execa`anvil --port ${config.port} --chain-id ${config.chainId} --fork-url ${config.upstreamRpcUrl} --disable-block-gas-limit`;
}

/**
 * execa renders the full anvil command — including the credential-bearing
 * `--fork-url` argument — into its error's message/command fields, and shell-
 * quotes it, so a URL containing a quote survives an exact-string strip. We
 * therefore surface a fixed error derived from none of execa's rendered-command
 * fields, copying only non-command diagnostics so failures stay debuggable.
 * anvil has no env option for `--fork-url`, so the URL stays in argv (visible to
 * a local-machine `ps` only); this keeps it out of every error we log or rethrow.
 */
class AnvilStartError extends Error {
  exitCode?: unknown;
  signal?: unknown;
  signalDescription?: unknown;
  code?: unknown;

  constructor() {
    super('anvil failed to start');
    this.name = 'AnvilStartError';
  }
}

function sanitizeAnvilError(error: unknown): AnvilStartError {
  const sanitized = new AnvilStartError();
  if (typeof error === 'object' && error !== null) {
    if ('exitCode' in error) sanitized.exitCode = error.exitCode;
    if ('signal' in error) sanitized.signal = error.signal;
    if ('signalDescription' in error) {
      sanitized.signalDescription = error.signalDescription;
    }
    if ('code' in error) sanitized.code = error.code;
  }
  return sanitized;
}

async function waitForEvmRpcReady(
  provider: JsonRpcProvider,
  signal: AbortSignal,
): Promise<void> {
  await waitUntilReady(
    () =>
      timeout(
        provider.getNetwork(),
        RPC_PROBE_TIMEOUT_MS,
        'anvil readiness probe timed out',
      ),
    { attempts: 10, baseRetryMs: 500, signal },
  );
}

const DEFAULT_START_EVM_FORK_DEPS: StartEvmForkDeps = {
  spawnAnvil: defaultSpawnAnvil,
  waitForReady: waitForEvmRpcReady,
};

/**
 * Rejects if `port` on 127.0.0.1 is already bound. A bind-test up front closes
 * the port-collision race: proving RPC health after spawn can otherwise pass
 * against an unrelated node already listening on the port, before our freshly
 * spawned anvil fails with EADDRINUSE.
 */
async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: Error) => {
      const code = 'code' in error ? error.code : undefined;
      reject(
        code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use`)
          : error,
      );
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '127.0.0.1');
  });
}

// A single process-level `exit` hook kills every still-running fork, rather than
// one listener per fork — which would trip MaxListenersExceededWarning past ten
// forks and retain each child's closure until process exit. A fork joins the
// registry on start and leaves when it is killed or its child exits.
const runningForkKills = new Set<() => void>();
let forkExitHookInstalled = false;

function trackForkExit(killFork: () => void): () => void {
  runningForkKills.add(killFork);
  if (!forkExitHookInstalled) {
    forkExitHookInstalled = true;
    process.once('exit', () => {
      for (const kill of Array.from(runningForkKills)) {
        kill();
      }
    });
  }
  return () => {
    runningForkKills.delete(killFork);
  };
}

async function startEvmFork(
  config: EvmForkManagerConfig,
  deps: StartEvmForkDeps = DEFAULT_START_EVM_FORK_DEPS,
): Promise<RunningEvmFork> {
  const endpoint = `${LOCAL_HOST}:${config.port}`;

  // Fail fast if the port is taken, before spawning, so we never treat another
  // process's RPC as our fork.
  await assertPortAvailable(config.port);

  let killOnError: ((isPanicking: boolean) => Promise<void>) | undefined;
  try {
    let anvilProcess: AnvilProcessHandle;
    try {
      anvilProcess = deps.spawnAnvil(config);
    } catch (error: unknown) {
      // A synchronous spawn throw (e.g. execa rejecting an argument that
      // contains a NUL byte) can embed the credential-bearing URL in its
      // message; sanitize it at the source so it never leaks.
      throw sanitizeAnvilError(error);
    }

    const onProcessExit = (): void => {
      void kill(false).catch((error: unknown) =>
        logDebug(
          `Failed to kill anvil fork for chain ${config.chainName}`,
          error,
        ),
      );
    };
    const kill = async (isPanicking: boolean): Promise<void> => {
      untrackFork();
      anvilProcess.kill(isPanicking ? 'SIGTERM' : 'SIGINT');
    };
    killOnError = kill;

    // Kill this fork if the process exits; drop it from the registry once the
    // child is gone (killed or exited) so a single process-level `exit` hook
    // covers any number of forks without accumulating listeners. Registered
    // before the readiness race so the failure path's kill can untrack it.
    const untrackFork = trackForkExit(onProcessExit);
    void anvilProcess.then(
      () => untrackFork(),
      () => untrackFork(),
    );

    const provider = new JsonRpcProvider(endpoint);
    // Abort the readiness probe the instant the race settles so no retry timer
    // keeps polling a dead port after anvil exits before its RPC is ready.
    const controller = new AbortController();
    const readiness = deps.waitForReady(provider, controller.signal);
    // Reject if anvil exits before its RPC is ready (e.g. the port is already
    // occupied) so we never treat another process's RPC as our fork.
    const exited = anvilProcess.then(
      () => {
        throw new Error('anvil exited before its RPC was ready');
      },
      (error: unknown) => {
        throw sanitizeAnvilError(error);
      },
    );
    // A later exit (e.g. on kill once readiness has won) must not surface as an
    // unhandled rejection after the race settles.
    exited.catch(() => {});
    try {
      await Promise.race([readiness, exited]);
    } finally {
      controller.abort();
    }

    return new RunningEvmFork(provider, endpoint, kill);
  } catch (error) {
    // Kill any running anvil process otherwise the process will keep running
    // in the background.
    if (killOnError) {
      await killOnError(true);
    }

    // Both anvil-error sources are sanitized at their source (the synchronous
    // spawn throw above and the async `exited` mapping), so no URL-bearing error
    // reaches here; rethrow verbatim to preserve real readiness/exit messages.
    throw error;
  }
}

export class EvmForkManager implements IForkManager<ForkedChainConfig> {
  private running?: RunningEvmFork;

  constructor(
    private readonly config: EvmForkManagerConfig,
    private readonly deps?: StartEvmForkDeps,
  ) {}

  private get requireRunning(): RunningEvmFork {
    const running = this.running;
    assert(running, `Fork not started for chain ${this.config.chainName}`);
    return running;
  }

  async start(): Promise<void> {
    this.running = await startEvmFork(this.config, this.deps);
  }

  async applyForkConfig(config: ForkedChainConfig): Promise<void> {
    const { provider } = this.requireRunning;

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
  }

  getForkedChainMetadata(): ForkedChainMetadata {
    return {
      rpcUrls: [{ http: this.requireRunning.endpoint }],
      blocks: { confirmations: 1 },
    };
  }

  kill(): void {
    void this.running
      ?.kill(false)
      .catch((error: unknown) =>
        logDebug(
          `Failed to kill anvil fork for chain ${this.config.chainName}`,
          error,
        ),
      );
  }
}

export function createEvmForkManagerFactory(
  multiProvider: MultiProvider,
): ForkManagerFactory {
  return (ctx) =>
    new EvmForkManager({
      chainName: ctx.chainName,
      chainId: multiProvider.getChainMetadata(ctx.chainName).chainId,
      upstreamRpcUrl: ctx.upstreamRpcUrl,
      port: ctx.port,
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
    // Advance once per iteration (before any `continue`) so fallback `#n`
    // annotations stay unique even when a tx short-circuits on a revert assert.
    txCounter++;
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
        `Transaction "${annotation}" reverted on chain ${chainName}`,
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
