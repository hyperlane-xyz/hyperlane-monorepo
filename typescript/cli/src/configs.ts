import fs from 'fs';
import { z } from 'zod';

import { TokenType } from '@hyperlane-xyz/hyperlane-token';
import {
  ChainMap,
  ChainMetadata,
  HyperlaneContractsMap,
  ModuleType,
  MultisigIsmConfig,
  isValidChainMetadata,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { getMultiProvider } from './context.js';
import { errorRed, log, logGreen } from './logger.js';
import { readYamlOrJson } from './utils/files.js';

export function readChainConfig(filepath: string) {
  log(`Reading file configs in ${filepath}`);
  const chainToMetadata = readYamlOrJson<ChainMap<ChainMetadata>>(filepath);

  if (
    !chainToMetadata ||
    typeof chainToMetadata !== 'object' ||
    !Object.keys(chainToMetadata).length
  ) {
    errorRed(`No configs found in ${filepath}`);
    process.exit(1);
  }

  for (const [chain, metadata] of Object.entries(chainToMetadata)) {
    if (!isValidChainMetadata(metadata)) {
      errorRed(`Chain ${chain} has invalid metadata`);
      errorRed(
        `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      process.exit(1);
    }
    if (metadata.name !== chain) {
      errorRed(`Chain ${chain} name does not match key`);
      process.exit(1);
    }
  }

  // Ensure multiprovider accepts this metadata
  getMultiProvider(chainToMetadata);

  logGreen(`All chain configs in ${filepath} are valid`);
  return chainToMetadata;
}

export function readChainConfigIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    log('No chain config file provided');
    return {};
  } else {
    return readChainConfig(filePath);
  }
}

const DeploymentArtifactsSchema = z
  .object({})
  .catchall(z.object({}).catchall(z.string()));

export function readDeploymentArtifacts(filePath: string) {
  const artifacts = readYamlOrJson<HyperlaneContractsMap<any>>(filePath);
  if (!artifacts) throw new Error(`No artifacts found at ${filePath}`);
  const result = DeploymentArtifactsSchema.safeParse(artifacts);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid artifacts: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return artifacts;
}

const MultisigConfigSchema = z.object({}).catchall(
  z.object({
    type: z.string(),
    threshold: z.number(),
    validators: z.array(z.string()),
  }),
);

export function readMultisigConfig(filePath: string) {
  const config = readYamlOrJson<ChainMap<MultisigIsmConfig>>(filePath);
  if (!config) throw new Error(`No multisig config found at ${filePath}`);
  const result = MultisigConfigSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid multisig config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;
  const formattedConfig = objMap(parsedConfig, (_, config) => ({
    ...config,
    type: humanReadableIsmTypeToEnum(config.type),
  }));

  return formattedConfig as ChainMap<MultisigIsmConfig>;
}

function humanReadableIsmTypeToEnum(type: string): ModuleType {
  for (const [key, value] of Object.entries(ModuleType)) {
    if (key.toLowerCase() === type) return parseInt(value.toString(), 10);
  }
  throw new Error(`Invalid ISM type ${type}`);
}

const ConnectionConfigSchema = {
  mailbox: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
  interchainSecurityModule: z.string().optional(),
  foreignDeployment: z.string().optional(),
};

export const WarpRouteConfigSchema = z.object({
  base: z.object({
    type: z.literal(TokenType.native).or(z.literal(TokenType.collateral)),
    chainName: z.string(),
    address: z.string().optional(),
    isNft: z.boolean().optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    ...ConnectionConfigSchema,
  }),
  synthetics: z
    .array(
      z.object({
        chainName: z.string(),
        name: z.string().optional(),
        symbol: z.string().optional(),
        totalSupply: z.number().optional(),
        ...ConnectionConfigSchema,
      }),
    )
    .nonempty(),
});

export type WarpRouteConfig = z.infer<typeof WarpRouteConfigSchema>;

export function readWarpRouteConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No warp config found at ${filePath}`);
  const result = WarpRouteConfigSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid warp config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return result.data;
}
