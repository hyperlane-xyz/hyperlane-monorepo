#!/usr/bin/env node
import { Wallet } from 'ethers';
import { pino, type Logger } from 'pino';
import { Keypair } from '@solana/web3.js';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  applyRpcUrlOverridesFromEnv,
  assert,
  normalizeAddressEvm,
  ProtocolType,
  toWei,
} from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { ExternalBridgeType } from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
import type { InventorySignerConfig } from '../core/InventoryRebalancer.js';
import type {
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  getExternalBridgeUsage,
  parseExternalBridgeArgs,
  runExternalBridgeCommand,
  type ExternalBridgeScriptOptions,
  type ExternalBridgeScriptResult,
  type ResolvedExternalBridgeContext,
} from './externalBridgeRunner.js';
import { getExternalBridgeTokenAddress } from '../utils/tokenUtils.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';

async function main(): Promise<void> {
  const options = parseExternalBridgeArgs(process.argv.slice(2));
  const logger = pino({
    level: process.env.LOG_LEVEL ?? (options.json ? 'error' : 'warn'),
  });

  try {
    const context = await resolveExternalBridgeContext(options, logger);
    const result = await runExternalBridgeCommand(
      context,
      options,
      logger,
      options.json ? undefined : printStatusUpdate,
    );
    printResult(result, options.json);
  } catch (error) {
    if (error instanceof Error && error.message === getExternalBridgeUsage()) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stderr.write(
        `${JSON.stringify({ error: message }, bigintReplacer, 2)}\n`,
      );
    } else {
      process.stderr.write(`External bridge script failed: ${message}\n`);
    }
    process.exit(1);
  }
}

async function resolveExternalBridgeContext(
  options: ExternalBridgeScriptOptions,
  logger: Logger,
): Promise<ResolvedExternalBridgeContext> {
  const config = RebalancerConfig.load(options.configFile);
  const inventoryPrivateKeys = loadInventoryPrivateKeysFromEnv(process.env);

  const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
  const registry = getRegistry({
    registryUris: [registryUri],
    enableProxy: true,
    logger,
  });
  const chainMetadata = await registry.getMetadata();
  applyRpcUrlOverridesFromEnv(chainMetadata);

  const multiProvider = new MultiProvider(chainMetadata);
  const contextFactory = await RebalancerContextFactory.create(
    config,
    multiProvider,
    undefined,
    registry,
    logger,
    inventoryPrivateKeys,
  );
  const bridgeRegistry = contextFactory.createExternalBridgeRegistry();
  const bridge = bridgeRegistry[options.bridge];
  assert(
    bridge,
    `Bridge ${options.bridge} is not configured for ${config.warpRouteId}`,
  );

  const originToken = contextFactory.getTokenForChain(options.origin);
  assert(
    originToken,
    `Origin token not found for chain ${options.origin} in ${config.warpRouteId}`,
  );
  const destinationToken = contextFactory.getTokenForChain(options.destination);
  assert(
    destinationToken,
    `Destination token not found for chain ${options.destination} in ${config.warpRouteId}`,
  );

  const fromChainId = Number(multiProvider.getChainId(options.origin));
  const toChainId = Number(multiProvider.getChainId(options.destination));
  assert(
    Number.isFinite(fromChainId),
    `Invalid chainId for origin ${options.origin}`,
  );
  assert(
    Number.isFinite(toChainId),
    `Invalid chainId for destination ${options.destination}`,
  );

  const fromTokenAddress = getExternalBridgeTokenAddress(
    originToken,
    options.bridge,
    () => getNativeTokenAddress(bridge, options.bridge),
  );
  const toTokenAddress = getExternalBridgeTokenAddress(
    destinationToken,
    options.bridge,
    () => getNativeTokenAddress(bridge, options.bridge),
  );

  const sourceProtocol = multiProvider.getProtocol(options.origin);
  const destinationProtocol = multiProvider.getProtocol(options.destination);
  const inventorySigners = config.inventorySigners;

  let fromAddress: string | undefined;
  let toAddress: string | undefined;
  let amountLocal: bigint | undefined;

  if (options.mode !== 'wait') {
    const sourceKey = inventoryPrivateKeys[sourceProtocol];
    assert(
      sourceKey,
      `Missing inventory signer key for source protocol ${sourceProtocol}. Set ${getInventoryKeyHint(
        sourceProtocol,
      )}.`,
    );

    fromAddress = resolveInventoryAddress(
      sourceProtocol,
      inventorySigners,
      inventoryPrivateKeys,
      true,
    );
    toAddress =
      options.recipient ??
      resolveDefaultRecipientAddress({
        sourceProtocol,
        destinationProtocol,
        inventorySigners,
        inventoryPrivateKeys,
        sourceAddress: fromAddress,
      });
    assert(options.amount, '--amount is required');
    amountLocal = BigInt(toWei(options.amount, originToken.decimals));
  }

  return {
    bridgeType: options.bridge,
    bridge,
    origin: options.origin,
    destination: options.destination,
    fromChainId,
    toChainId,
    originToken,
    destinationToken,
    fromTokenAddress,
    toTokenAddress,
    fromAddress,
    toAddress,
    amountLocal,
    privateKeys: inventoryPrivateKeys,
  };
}

function loadInventoryPrivateKeysFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<Record<ProtocolType, string>> {
  const inventoryPrivateKeys: Partial<Record<ProtocolType, string>> = {};

  for (const protocol of Object.values(ProtocolType)) {
    const envKey = `HYP_INVENTORY_KEY_${protocol.toUpperCase()}`;
    const value = env[envKey];
    if (value) {
      inventoryPrivateKeys[protocol] = value;
    }
  }

  if (!inventoryPrivateKeys[ProtocolType.Ethereum] && env.HYP_INVENTORY_KEY) {
    inventoryPrivateKeys[ProtocolType.Ethereum] = env.HYP_INVENTORY_KEY;
  }

  return inventoryPrivateKeys;
}

function resolveDefaultRecipientAddress(args: {
  sourceProtocol: ProtocolType;
  destinationProtocol: ProtocolType;
  inventorySigners?: Partial<Record<ProtocolType, InventorySignerConfig>>;
  inventoryPrivateKeys: Partial<Record<ProtocolType, string>>;
  sourceAddress: string;
}): string {
  const destinationAddress = resolveInventoryAddress(
    args.destinationProtocol,
    args.inventorySigners,
    args.inventoryPrivateKeys,
    false,
  );
  if (destinationAddress) return destinationAddress;

  assert(
    args.destinationProtocol === args.sourceProtocol,
    `Missing destination inventory signer for protocol ${args.destinationProtocol}. Set ${getInventoryKeyHint(
      args.destinationProtocol,
    )}, configure inventorySigners.${args.destinationProtocol}, or pass --recipient.`,
  );
  return args.sourceAddress;
}

function resolveInventoryAddress(
  protocol: ProtocolType,
  inventorySigners:
    | Partial<Record<ProtocolType, InventorySignerConfig>>
    | undefined,
  inventoryPrivateKeys: Partial<Record<ProtocolType, string>>,
  requireKey: boolean,
): string {
  const configuredAddress = inventorySigners?.[protocol]?.address;
  const key = inventoryPrivateKeys[protocol];

  if (!key) {
    assert(
      !requireKey || configuredAddress,
      `Missing inventory signer key for protocol ${protocol}. Set ${getInventoryKeyHint(
        protocol,
      )}.`,
    );
    assert(
      configuredAddress,
      `Missing inventory signer address for ${protocol}`,
    );
    return configuredAddress;
  }

  const derivedAddress = deriveAddressForProtocol(protocol, key);
  if (configuredAddress) {
    const mismatch =
      protocol === ProtocolType.Ethereum
        ? normalizeAddressEvm(configuredAddress) !==
          normalizeAddressEvm(derivedAddress)
        : configuredAddress !== derivedAddress;
    assert(
      !mismatch,
      `inventorySigners.${protocol} mismatch: config has ${configuredAddress} but env derives to ${derivedAddress}`,
    );
  }

  return derivedAddress;
}

function deriveAddressForProtocol(
  protocol: ProtocolType,
  privateKey: string,
): string {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return new Wallet(privateKey).address;
    case ProtocolType.Sealevel: {
      const keyBytes = parseSolanaPrivateKey(privateKey);
      return Keypair.fromSecretKey(keyBytes).publicKey.toBase58();
    }
    default:
      throw new Error(
        `Unsupported protocol for inventory signer derivation: ${protocol}`,
      );
  }
}

function getNativeTokenAddress(
  bridge: IExternalBridge,
  bridgeType: ExternalBridgeType,
): string {
  assert(
    bridge.getNativeTokenAddress,
    `Bridge ${bridgeType} does not expose getNativeTokenAddress()`,
  );
  return bridge.getNativeTokenAddress();
}

function getInventoryKeyHint(protocol: ProtocolType): string {
  return protocol === ProtocolType.Ethereum
    ? 'HYP_INVENTORY_KEY_ETHEREUM (or fallback HYP_INVENTORY_KEY)'
    : `HYP_INVENTORY_KEY_${protocol.toUpperCase()}`;
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
          `from=${result.quote.fromAmount} to=${result.quote.toAmount} min=${result.quote.toAmountMin}`,
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

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

void main();
