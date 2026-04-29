#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Wallet, ethers } from 'ethers';
import { pino, type Logger } from 'pino';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  applyRpcUrlOverridesFromEnv,
  assert,
  ensure0x,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { FluentBridge } from '../bridges/FluentBridge.js';
import { KatanaBridge } from '../bridges/KatanaBridge.js';
import { LiFiBridge } from '../bridges/LiFiBridge.js';
import { ExternalBridgeType } from '../config/types.js';
import type {
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';

import {
  runExternalBridgeCommand,
  type ExternalBridgeScriptMode,
  type ExternalBridgeScriptOptions,
  type ExternalBridgeScriptResult,
  type ResolvedExternalBridgeContext,
} from './externalBridgeRunner.js';

const NATIVE_TOKEN_SENTINEL = ethers.constants.AddressZero;

type DirectBridgeArgs = {
  bridge: ExternalBridgeType;
  origin: string;
  destination: string;
  mode: ExternalBridgeScriptMode | 'status';
  amount?: string;
  recipient?: string;
  tokenAddress?: string;
  txHash?: string;
  privateKey?: string;
  keyFile?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  json: boolean;
};

function getUsage(): string {
  return [
    'Usage:',
    '  pnpm bridge:direct --bridge <fluent|katana|lifi> --origin <chain> --destination <chain> [options]',
    '',
    'Options:',
    '  --mode <quote|execute|wait|run|status>   default: run',
    '  --amount <human-readable>                e.g. 0.001ether, 1000000 (wei). Required for quote/execute/run',
    '  --recipient <address>                    Optional; defaults to signer',
    '  --token-address <address>                Optional; defaults to native sentinel for the bridge',
    '  --tx-hash <hash>                         Required for wait/status',
    '  --private-key <0x...>                    Or use --key-file',
    '  --key-file <path>                        Path to file containing private key',
    '  --timeout-ms <ms>                        Wait timeout, default 1800000 (30 min)',
    '  --poll-interval-ms <ms>                  default 30000',
    '  --json                                   Machine-readable JSON',
  ].join('\n');
}

function parseDirectArgs(argv: string[]): DirectBridgeArgs {
  const args = [...argv];
  const getValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    assert(index + 1 < args.length, `Missing value for ${flag}`);
    return args[index + 1];
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  if (hasFlag('--help') || hasFlag('-h')) {
    throw new Error(getUsage());
  }

  const bridge = getValue('--bridge') as ExternalBridgeType | undefined;
  assert(bridge, '--bridge is required');
  assert(
    Object.values(ExternalBridgeType).includes(bridge),
    `Invalid --bridge: ${bridge}`,
  );

  const origin = getValue('--origin');
  assert(origin, '--origin is required');
  const destination = getValue('--destination');
  assert(destination, '--destination is required');

  const mode = (getValue('--mode') ?? 'run') as DirectBridgeArgs['mode'];
  assert(
    ['quote', 'execute', 'wait', 'run', 'status'].includes(mode),
    `Invalid --mode: ${mode}`,
  );

  const amount = getValue('--amount');
  const txHash = getValue('--tx-hash');

  if (mode === 'wait' || mode === 'status') {
    assert(txHash, `--tx-hash is required in ${mode} mode`);
  } else {
    assert(amount, '--amount is required for quote/execute/run');
  }

  const timeoutRaw = getValue('--timeout-ms');
  const timeoutMs =
    timeoutRaw === undefined ? 30 * 60_000 : Number.parseInt(timeoutRaw, 10);
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    `Invalid --timeout-ms: ${timeoutRaw}`,
  );

  const pollRaw = getValue('--poll-interval-ms');
  const pollIntervalMs =
    pollRaw === undefined ? 30_000 : Number.parseInt(pollRaw, 10);
  assert(
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0,
    `Invalid --poll-interval-ms: ${pollRaw}`,
  );

  return {
    bridge,
    origin,
    destination,
    mode,
    amount,
    recipient: getValue('--recipient'),
    tokenAddress: getValue('--token-address'),
    txHash,
    privateKey: getValue('--private-key'),
    keyFile: getValue('--key-file'),
    timeoutMs,
    pollIntervalMs,
    json: hasFlag('--json'),
  };
}

function resolvePrivateKey(args: DirectBridgeArgs): string {
  if (args.privateKey) return ensure0x(args.privateKey.trim());
  assert(args.keyFile, 'Either --private-key or --key-file is required');
  const expanded = args.keyFile.startsWith('~')
    ? path.join(os.homedir(), args.keyFile.slice(1))
    : args.keyFile;
  const raw = fs.readFileSync(expanded, 'utf8').trim();
  return ensure0x(raw);
}

function buildBridge(
  bridgeType: ExternalBridgeType,
  multiProvider: MultiProvider,
  logger: Logger,
): IExternalBridge {
  const chainMetadata = multiProvider.metadata;
  switch (bridgeType) {
    case ExternalBridgeType.Fluent:
      return new FluentBridge(
        { integrator: 'hyperlane', chainMetadata },
        logger,
      );
    case ExternalBridgeType.Katana:
      return new KatanaBridge(
        { integrator: 'hyperlane', chainMetadata },
        logger,
      );
    case ExternalBridgeType.LiFi:
      return new LiFiBridge({ integrator: 'hyperlane', chainMetadata }, logger);
    default: {
      const _exhaustive: never = bridgeType;
      throw new Error(`Unsupported bridge type: ${String(_exhaustive)}`);
    }
  }
}

function parseAmountToWei(amount: string): bigint {
  const trimmed = amount.trim();
  // Allow ethers' parseUnits-style suffixes ("0.001ether", "100gwei") or plain wei integers.
  const suffixMatch = trimmed.match(/^([0-9.]+)(ether|gwei|wei)$/i);
  if (suffixMatch) {
    const [, value, unit] = suffixMatch;
    return BigInt(
      ethers.utils.parseUnits(value, unit.toLowerCase()).toString(),
    );
  }
  // Bare number -> wei (matches cast send --value semantics).
  return BigInt(trimmed);
}

async function resolveContext(
  args: DirectBridgeArgs,
  logger: Logger,
): Promise<ResolvedExternalBridgeContext> {
  const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
  const registry = getRegistry({
    registryUris: [registryUri],
    enableProxy: true,
    logger,
  });
  const chainMetadata = await registry.getMetadata();
  applyRpcUrlOverridesFromEnv(chainMetadata);

  const multiProvider = new MultiProvider(chainMetadata);
  const bridge = buildBridge(args.bridge, multiProvider, logger);

  const fromChainId = Number(multiProvider.getChainId(args.origin));
  const toChainId = Number(multiProvider.getChainId(args.destination));
  assert(
    Number.isFinite(fromChainId),
    `Invalid chainId for origin ${args.origin}`,
  );
  assert(
    Number.isFinite(toChainId),
    `Invalid chainId for destination ${args.destination}`,
  );

  const tokenAddress = args.tokenAddress
    ? normalizeAddressEvm(args.tokenAddress)
    : (bridge.getNativeTokenAddress?.() ?? NATIVE_TOKEN_SENTINEL);

  const privateKey = resolvePrivateKey(args);
  const fromAddress = normalizeAddressEvm(new Wallet(privateKey).address);
  const toAddress = args.recipient
    ? normalizeAddressEvm(args.recipient)
    : fromAddress;

  let amountLocal: bigint | undefined;
  if (args.mode !== 'wait' && args.mode !== 'status') {
    assert(args.amount, '--amount is required');
    amountLocal = parseAmountToWei(args.amount);
  }

  // Tokens are only used by runExternalBridgeCommand for serialization output;
  // we only need their addressOrDenom field to round-trip into the result.
  // Construct minimal placeholders that satisfy the field accesses.
  const placeholderToken = {
    addressOrDenom: tokenAddress,
    decimals: 18,
    chainName: args.origin,
    standard: 'EvmHypNative',
  } as unknown as ResolvedExternalBridgeContext['originToken'];

  return {
    bridgeType: args.bridge,
    bridge,
    origin: args.origin,
    destination: args.destination,
    fromChainId,
    toChainId,
    originToken: placeholderToken,
    destinationToken: placeholderToken,
    fromTokenAddress: tokenAddress,
    toTokenAddress: tokenAddress,
    fromAddress,
    toAddress,
    amountLocal,
    privateKeys: { [ProtocolType.Ethereum]: privateKey },
  };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function printStatusUpdate(status: BridgeTransferStatus): void {
  process.stdout.write(
    `Bridge status: ${JSON.stringify(status, bigintReplacer, 2)}\n`,
  );
}

function printResult(result: ExternalBridgeScriptResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, bigintReplacer, 2)}\n`);
    return;
  }

  switch (result.mode) {
    case 'quote':
      process.stdout.write(
        [
          `Quoted ${result.bridge} ${result.origin} -> ${result.destination}`,
          `from=${result.quote.fromAmount} to=${result.quote.toAmount} min=${result.quote.toAmountMin}`,
          `tool=${result.quote.tool} gas=${result.quote.gasCosts} fees=${result.quote.feeCosts}`,
        ].join('\n') + '\n',
      );
      return;
    case 'execute':
      process.stdout.write(
        [
          `Executed ${result.bridge} ${result.origin} -> ${result.destination}`,
          `txHash=${result.execution.txHash}`,
          `transferId=${result.execution.transferId ?? '<none>'}`,
        ].join('\n') + '\n',
      );
      return;
    case 'wait':
      process.stdout.write(
        [
          `Waited on ${result.bridge} ${result.origin} -> ${result.destination}`,
          `txHash=${result.txHash}`,
          `elapsedMs=${result.elapsedMs}`,
          `status=${JSON.stringify(result.status, bigintReplacer)}`,
        ].join('\n') + '\n',
      );
      return;
    case 'run':
      process.stdout.write(
        [
          `Completed ${result.bridge} ${result.origin} -> ${result.destination}`,
          `txHash=${result.execution.txHash}`,
          `elapsedMs=${result.elapsedMs}`,
          `finalStatus=${JSON.stringify(result.finalStatus, bigintReplacer)}`,
        ].join('\n') + '\n',
      );
      return;
  }
}

async function runStatusMode(
  args: DirectBridgeArgs,
  context: ResolvedExternalBridgeContext,
): Promise<void> {
  assert(args.txHash, '--tx-hash is required in status mode');
  const status = await context.bridge.getStatus(
    args.txHash,
    context.fromChainId,
    context.toChainId,
  );
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'status',
          bridge: args.bridge,
          origin: args.origin,
          destination: args.destination,
          txHash: args.txHash,
          status,
        },
        bigintReplacer,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${args.bridge} ${args.origin} -> ${args.destination} ${args.txHash}: ${JSON.stringify(
        status,
        bigintReplacer,
      )}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseDirectArgs(process.argv.slice(2));
  const logger = pino({
    level: process.env.LOG_LEVEL ?? (args.json ? 'error' : 'warn'),
  });

  try {
    const context = await resolveContext(args, logger);

    if (args.mode === 'status') {
      await runStatusMode(args, context);
      return;
    }

    const runOptions: ExternalBridgeScriptOptions = {
      configFile: '<direct>',
      bridge: args.bridge,
      origin: args.origin,
      destination: args.destination,
      mode: args.mode,
      amount: args.amount,
      recipient: args.recipient,
      txHash: args.txHash,
      slippage: undefined,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
      json: args.json,
    };

    const result = await runExternalBridgeCommand(
      context,
      runOptions,
      logger,
      args.json ? undefined : printStatusUpdate,
    );
    printResult(result, args.json);
  } catch (error) {
    if (error instanceof Error && error.message === getUsage()) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) {
      process.stderr.write(
        `${JSON.stringify({ error: message }, bigintReplacer, 2)}\n`,
      );
    } else {
      process.stderr.write(`bridge:direct failed: ${message}\n`);
    }
    process.exit(1);
  }
}

void main();
