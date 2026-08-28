import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChainFundingConfig,
  FunderConfig,
  FundingPolicy,
  KeyfunderConfig,
  ProtocolType,
  RecipientConfig,
  StrategyConfig,
} from '../types';

export const ProtocolTypeSchema = z.enum(['ethereum', 'sealevel', 'cosmos']);

export const KeyTypeSchema = z.enum(['privateKey', 'awsKms', 'keystore', 'mnemonic']);

export const FunderConfigSchema = z.object({
  type: KeyTypeSchema,
  key: z.string().optional(),
  mnemonic: z.string().optional(),
  kmsKeyId: z.string().optional(),
  kmsRegion: z.string().optional(),
  keystorePath: z.string().optional(),
  password: z.string().optional(),
  passwordEnv: z.string().optional(),
  minReserve: z.union([z.record(z.string()), z.string()]).optional(),
});

export const FundingPolicySchema = z.object({
  minBalance: z.string().min(1, 'minBalance is required'),
  desiredBalance: z.string().min(1, 'desiredBalance is required'),
  maxFundingAmount: z.string().optional(),
});

export const RecipientConfigSchema = z.object({
  name: z.string().optional(),
  address: z.string().min(1, 'address is required'),
  policy: z.string().optional(),
  minBalance: z.string().optional(),
  desiredBalance: z.string().optional(),
  maxFundingAmount: z.string().optional(),
  strategy: z.string().optional(),
  tokenAddress: z.string().optional(),
  tokenDenom: z.string().optional(),
});

export const StrategyConfigSchema = z
  .object({
    type: z.string(),
    warpRouteAddress: z.string().optional(),
    destinationDomain: z.number().optional(),
    bridgeAddress: z.string().optional(),
    portalAddress: z.string().optional(),
    inboxAddress: z.string().optional(),
    l2GasLimit: z.number().optional(),
    maxSubmissionCost: z.string().optional(),
    maxGas: z.string().optional(),
    gasPriceBid: z.string().optional(),
    denom: z.string().optional(),
  })
  .passthrough();

export const ChainFundingConfigSchema = z
  .object({
    chain: z.string().optional(),
    protocol: ProtocolTypeSchema.optional(),
    rpcUrl: z.string().optional(),
    fallbackRpcUrls: z.array(z.string()).optional(),
    funderKey: FunderConfigSchema.optional(),
    funderMinReserve: z.string().optional(),
    gasBufferMultiplier: z.number().positive().default(1.2).optional(),
    strategy: z.string().default('direct').optional(),
    strategyConfig: StrategyConfigSchema.optional(),
    recipients: z.array(RecipientConfigSchema).optional(),
    nativeDecimals: z.number().int().nonnegative().optional(),
    nativeSymbol: z.string().optional(),
  })
  .passthrough();

export const KeyfunderConfigSchema = z.object({
  globalFunderKey: FunderConfigSchema.optional(),
  funder: FunderConfigSchema.optional(),
  chains: z.record(ChainFundingConfigSchema),
  policies: z.record(FundingPolicySchema).optional(),
  strategies: z.record(StrategyConfigSchema).optional(),
  cronSchedule: z.string().optional(),
  daemonIntervalSeconds: z.number().positive().optional(),
  intervalSec: z.number().positive().optional(),
  dryRun: z.boolean().default(false).optional(),
  metricsPort: z.number().int().positive().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info').optional(),
});

/**
 * Returns default decimals for protocol
 */
export function getDefaultDecimals(protocol: ProtocolType): number {
  switch (protocol) {
    case 'ethereum':
      return 18;
    case 'sealevel':
      return 9;
    case 'cosmos':
      return 6;
    default:
      return 18;
  }
}

/**
 * Returns default native currency symbol for protocol
 */
export function getDefaultSymbol(protocol: ProtocolType): string {
  switch (protocol) {
    case 'ethereum':
      return 'ETH';
    case 'sealevel':
      return 'SOL';
    case 'cosmos':
      return 'ATOM';
    default:
      return 'NATIVE';
  }
}

/**
 * Substitute environment variables in strings, e.g. ${MY_ENV_VAR} or ${MY_ENV_VAR:-default}
 */
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, expression) => {
      const parts = expression.split(':-');
      const varName = parts[0].trim();
      const defaultValue = parts.length > 1 ? parts.slice(1).join(':-') : '';
      return process.env[varName] !== undefined ? process.env[varName]! : defaultValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvVars(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Validate and populate defaults on raw config object
 */
export function validateConfig(raw: unknown): KeyfunderConfig {
  const substituted = substituteEnvVars(raw);
  const parsed = KeyfunderConfigSchema.parse(substituted);

  // Normalize funder config (funder or globalFunderKey)
  const rootFunder = parsed.funder || parsed.globalFunderKey;

  for (const [chainName, chainConfig] of Object.entries(parsed.chains)) {
    if (!chainConfig.chain) {
      chainConfig.chain = chainName;
    }
    if (!chainConfig.protocol) {
      chainConfig.protocol = 'ethereum';
    }
    if (!chainConfig.recipients) {
      chainConfig.recipients = [];
    }
    if (chainConfig.nativeDecimals === undefined) {
      chainConfig.nativeDecimals = getDefaultDecimals(chainConfig.protocol as ProtocolType);
    }
    if (!chainConfig.nativeSymbol) {
      chainConfig.nativeSymbol = getDefaultSymbol(chainConfig.protocol as ProtocolType);
    }
    if (!chainConfig.funderKey && rootFunder) {
      chainConfig.funderKey = rootFunder;
    }
  }

  return parsed as KeyfunderConfig;
}

/**
 * Parse JSON or YAML string config
 */
export function parseConfig(rawContent: string): KeyfunderConfig {
  const parsedJson = JSON.parse(rawContent);
  return validateConfig(parsedJson);
}

/**
 * Load and validate config from file path
 */
export function loadConfigFromFile(filePath: string): KeyfunderConfig {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  return parseConfig(content);
}
