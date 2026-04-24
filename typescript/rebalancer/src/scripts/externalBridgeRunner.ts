import { assert } from '@hyperlane-xyz/utils';
import type { Token } from '@hyperlane-xyz/sdk';
import type { Logger } from 'pino';

import { ExternalBridgeType } from '../config/types.js';
import type {
  BridgeQuote,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import type { ProtocolType } from '@hyperlane-xyz/utils';

export type ExternalBridgeScriptMode = 'quote' | 'execute' | 'wait' | 'run';

export type ExternalBridgeScriptOptions = {
  configFile: string;
  bridge: ExternalBridgeType;
  origin: string;
  destination: string;
  amount?: string;
  recipient?: string;
  txHash?: string;
  mode: ExternalBridgeScriptMode;
  slippage?: number;
  timeoutMs: number;
  pollIntervalMs: number;
  json: boolean;
};

export type ResolvedExternalBridgeContext = {
  bridgeType: ExternalBridgeType;
  bridge: IExternalBridge;
  origin: string;
  destination: string;
  fromChainId: number;
  toChainId: number;
  originToken: Token;
  destinationToken: Token;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAddress?: string;
  toAddress?: string;
  amountLocal?: bigint;
  privateKeys: Partial<Record<ProtocolType, string>>;
};

export type ExternalBridgeScriptResult =
  | {
      mode: 'quote';
      bridge: ExternalBridgeType;
      origin: string;
      destination: string;
      fromTokenAddress: string;
      toTokenAddress: string;
      fromAddress: string;
      toAddress: string;
      amountLocal: string;
      quote: {
        id: string;
        tool: string;
        fromAmount: string;
        toAmount: string;
        toAmountMin: string;
        executionDuration: number;
        gasCosts: string;
        feeCosts: string;
      };
    }
  | {
      mode: 'execute';
      bridge: ExternalBridgeType;
      origin: string;
      destination: string;
      fromTokenAddress: string;
      toTokenAddress: string;
      fromAddress: string;
      toAddress: string;
      amountLocal: string;
      quote: {
        id: string;
        tool: string;
        fromAmount: string;
        toAmount: string;
        toAmountMin: string;
        executionDuration: number;
        gasCosts: string;
        feeCosts: string;
      };
      execution: {
        txHash: string;
        fromChain: number;
        toChain: number;
        transferId?: string;
      };
    }
  | {
      mode: 'wait';
      bridge: ExternalBridgeType;
      origin: string;
      destination: string;
      txHash: string;
      elapsedMs: number;
      status: BridgeTransferStatus;
    }
  | {
      mode: 'run';
      bridge: ExternalBridgeType;
      origin: string;
      destination: string;
      fromTokenAddress: string;
      toTokenAddress: string;
      fromAddress: string;
      toAddress: string;
      amountLocal: string;
      quote: {
        id: string;
        tool: string;
        fromAmount: string;
        toAmount: string;
        toAmountMin: string;
        executionDuration: number;
        gasCosts: string;
        feeCosts: string;
      };
      execution: {
        txHash: string;
        fromChain: number;
        toChain: number;
        transferId?: string;
      };
      finalStatus: BridgeTransferStatus;
      elapsedMs: number;
    };

type WaitOptions = {
  bridge: IExternalBridge;
  txHash: string;
  fromChain: number;
  toChain: number;
  timeoutMs: number;
  pollIntervalMs: number;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  onStatusChange?: (status: BridgeTransferStatus) => void;
};

export function parseExternalBridgeArgs(
  argv: string[],
): ExternalBridgeScriptOptions {
  const args = [...argv];
  const getValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    assert(index + 1 < args.length, `Missing value for ${flag}`);
    return args[index + 1];
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  if (hasFlag('--help') || hasFlag('-h')) {
    throw new Error(getExternalBridgeUsage());
  }

  const mode = (getValue('--mode') ?? 'run') as ExternalBridgeScriptMode;
  assert(
    ['quote', 'execute', 'wait', 'run'].includes(mode),
    `Invalid --mode: ${mode}`,
  );

  const bridge = getValue('--bridge') as ExternalBridgeType | undefined;
  assert(bridge, '--bridge is required');
  assert(
    Object.values(ExternalBridgeType).includes(bridge),
    `Invalid --bridge: ${bridge}`,
  );

  const configFile = getValue('--config');
  assert(configFile, '--config is required');

  const origin = getValue('--origin');
  assert(origin, '--origin is required');

  const destination = getValue('--destination');
  assert(destination, '--destination is required');

  const amount = getValue('--amount');
  const txHash = getValue('--tx-hash');

  if (mode === 'wait') {
    assert(txHash, '--tx-hash is required in wait mode');
  } else {
    assert(amount, '--amount is required unless --mode wait');
  }

  const slippageRaw = getValue('--slippage');
  let slippage: number | undefined;
  if (slippageRaw !== undefined) {
    slippage = Number(slippageRaw);
    assert(!Number.isNaN(slippage), `Invalid --slippage: ${slippageRaw}`);
    assert(slippage >= 0, '--slippage must be non-negative');
  }

  const timeoutRaw = getValue('--timeout-ms');
  const timeoutMs =
    timeoutRaw === undefined ? 15 * 60_000 : Number.parseInt(timeoutRaw, 10);
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    `Invalid --timeout-ms: ${timeoutRaw}`,
  );

  const pollRaw = getValue('--poll-interval-ms');
  const pollIntervalMs =
    pollRaw === undefined ? 5_000 : Number.parseInt(pollRaw, 10);
  assert(
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0,
    `Invalid --poll-interval-ms: ${pollRaw}`,
  );

  return {
    configFile,
    bridge,
    origin,
    destination,
    amount,
    recipient: getValue('--recipient'),
    txHash,
    mode,
    slippage,
    timeoutMs,
    pollIntervalMs,
    json: hasFlag('--json'),
  };
}

export function getExternalBridgeUsage(): string {
  return [
    'Usage:',
    '  pnpm -C typescript/rebalancer bridge:dev --config <path> --bridge <katana|lifi> --origin <chain> --destination <chain> --mode <quote|execute|wait|run> [options]',
    '',
    'Options:',
    '  --amount <token-units>         Required for quote/execute/run',
    '  --tx-hash <hash>               Required for wait',
    '  --recipient <address>          Optional destination recipient',
    '  --slippage <decimal>           Optional slippage override (e.g. 0.005)',
    '  --timeout-ms <ms>              Wait timeout, default 900000',
    '  --poll-interval-ms <ms>        Wait poll interval, default 5000',
    '  --json                         Emit machine-readable JSON',
  ].join('\n');
}

export async function waitForBridgeCompletion({
  bridge,
  txHash,
  fromChain,
  toChain,
  timeoutMs,
  pollIntervalMs,
  logger,
  sleep = defaultSleep,
  onStatusChange,
}: WaitOptions): Promise<{ status: BridgeTransferStatus; elapsedMs: number }> {
  const start = Date.now();
  let lastSerialized: string | undefined;
  let lastStatus: BridgeTransferStatus = { status: 'not_found' };

  while (Date.now() - start < timeoutMs) {
    lastStatus = await bridge.getStatus(txHash, fromChain, toChain);
    const serialized = JSON.stringify(lastStatus, bigintReplacer);
    if (serialized !== lastSerialized) {
      lastSerialized = serialized;
      onStatusChange?.(lastStatus);
      logger.info(
        {
          txHash,
          fromChain,
          toChain,
          bridge: bridge.externalBridgeId,
          status: serialized,
        },
        'External bridge status changed',
      );
    }

    if (lastStatus.status === 'complete' || lastStatus.status === 'failed') {
      return {
        status: lastStatus,
        elapsedMs: Date.now() - start,
      };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for external bridge completion for ${txHash}. Last status: ${JSON.stringify(
      lastStatus,
      bigintReplacer,
    )}`,
  );
}

export async function runExternalBridgeCommand(
  context: ResolvedExternalBridgeContext,
  options: ExternalBridgeScriptOptions,
  logger: Logger,
  onStatusChange?: (status: BridgeTransferStatus) => void,
): Promise<ExternalBridgeScriptResult> {
  if (options.mode === 'wait') {
    assert(options.txHash, '--tx-hash is required in wait mode');
    const waited = await waitForBridgeCompletion({
      bridge: context.bridge,
      txHash: options.txHash,
      fromChain: context.fromChainId,
      toChain: context.toChainId,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      logger,
      onStatusChange,
    });

    return {
      mode: 'wait',
      bridge: context.bridgeType,
      origin: context.origin,
      destination: context.destination,
      txHash: options.txHash,
      elapsedMs: waited.elapsedMs,
      status: waited.status,
    };
  }

  assert(context.fromAddress, 'Missing source inventory address');
  assert(context.toAddress, 'Missing destination inventory address');
  assert(context.amountLocal !== undefined, 'Missing bridge amount');

  const quote = await context.bridge.quote({
    fromChain: context.fromChainId,
    toChain: context.toChainId,
    fromToken: context.fromTokenAddress,
    toToken: context.toTokenAddress,
    fromAmount: context.amountLocal,
    fromAddress: context.fromAddress,
    toAddress: context.toAddress,
    slippage: options.slippage,
  });
  const serializedQuote = serializeQuote(quote);

  if (options.mode === 'quote') {
    return {
      mode: 'quote',
      bridge: context.bridgeType,
      origin: context.origin,
      destination: context.destination,
      fromTokenAddress: context.fromTokenAddress,
      toTokenAddress: context.toTokenAddress,
      fromAddress: context.fromAddress,
      toAddress: context.toAddress,
      amountLocal: context.amountLocal.toString(),
      quote: serializedQuote,
    };
  }

  const execution = await context.bridge.execute(quote, context.privateKeys);
  const serializedExecution = serializeExecution(execution);

  if (options.mode === 'execute') {
    return {
      mode: 'execute',
      bridge: context.bridgeType,
      origin: context.origin,
      destination: context.destination,
      fromTokenAddress: context.fromTokenAddress,
      toTokenAddress: context.toTokenAddress,
      fromAddress: context.fromAddress,
      toAddress: context.toAddress,
      amountLocal: context.amountLocal.toString(),
      quote: serializedQuote,
      execution: serializedExecution,
    };
  }

  const waited = await waitForBridgeCompletion({
    bridge: context.bridge,
    txHash: execution.txHash,
    fromChain: context.fromChainId,
    toChain: context.toChainId,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    logger,
    onStatusChange,
  });

  return {
    mode: 'run',
    bridge: context.bridgeType,
    origin: context.origin,
    destination: context.destination,
    fromTokenAddress: context.fromTokenAddress,
    toTokenAddress: context.toTokenAddress,
    fromAddress: context.fromAddress,
    toAddress: context.toAddress,
    amountLocal: context.amountLocal.toString(),
    quote: serializedQuote,
    execution: serializedExecution,
    finalStatus: waited.status,
    elapsedMs: waited.elapsedMs,
  };
}

function serializeQuote(quote: BridgeQuote) {
  return {
    id: quote.id,
    tool: quote.tool,
    fromAmount: quote.fromAmount.toString(),
    toAmount: quote.toAmount.toString(),
    toAmountMin: quote.toAmountMin.toString(),
    executionDuration: quote.executionDuration,
    gasCosts: quote.gasCosts.toString(),
    feeCosts: quote.feeCosts.toString(),
  };
}

function serializeExecution(execution: BridgeTransferResult) {
  return {
    txHash: execution.txHash,
    fromChain: execution.fromChain,
    toChain: execution.toChain,
    transferId: execution.transferId,
  };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
