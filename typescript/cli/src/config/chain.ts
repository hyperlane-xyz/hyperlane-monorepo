import { confirm, input } from '@inquirer/prompts';

import {
  ChainMap,
  ChainMetadata,
  ChainMetadataSchema,
  chainMetadata as coreChainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMerge } from '@hyperlane-xyz/utils';

import { getMultiProvider } from '../context.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import {
  FileFormat,
  isFile,
  mergeYamlOrJson,
  readYamlOrJson,
} from '../utils/files.js';

export function readChainConfigs(filePath: string) {
  log(`Reading file configs in ${filePath}`);
  const chainToMetadata = readYamlOrJson<ChainMap<ChainMetadata>>(filePath);

  if (
    !chainToMetadata ||
    typeof chainToMetadata !== 'object' ||
    !Object.keys(chainToMetadata).length
  ) {
    errorRed(`No configs found in ${filePath}`);
    process.exit(1);
  }

  // Validate configs from file and merge in core configs as needed
  for (const chain of Object.keys(chainToMetadata)) {
    if (coreChainMetadata[chain]) {
      // For core chains, merge in the default config to allow users to override only some fields
      chainToMetadata[chain] = objMerge(
        coreChainMetadata[chain],
        chainToMetadata[chain],
      );
    }
    const parseResult = ChainMetadataSchema.safeParse(chainToMetadata[chain]);
    if (!parseResult.success) {
      errorRed(
        `Chain config for ${chain} is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
      );
      errorRed(JSON.stringify(parseResult.error.errors));
      process.exit(1);
    }
    if (chainToMetadata[chain].name !== chain) {
      errorRed(`Chain ${chain} name does not match key`);
      process.exit(1);
    }
  }

  // Ensure MultiProvider accepts this metadata
  getMultiProvider(chainToMetadata);

  logGreen(`All chain configs in ${filePath} are valid`);
  return chainToMetadata;
}

export function readChainConfigsIfExists(filePath?: string) {
  if (!filePath || !isFile(filePath)) {
    log('No chain config file provided');
    return {};
  } else {
    return readChainConfigs(filePath);
  }
}

export async function createChainConfig({
  format,
  outPath,
}: {
  format: FileFormat;
  outPath: string;
}) {
  logBlue('Creating a new chain config');
  const name = await input({
    message: 'Enter chain name (one word, lower case)',
  });
  const chainId = await input({ message: 'Enter chain id (number)' });
  const domainId = chainId;
  const rpcUrl = await input({ message: 'Enter http or https rpc url' });
  const metadata: ChainMetadata = {
    name,
    chainId: parseInt(chainId, 10),
    domainId: parseInt(domainId, 10),
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: rpcUrl }],
  };
  const wantAdvancedConfig = await confirm({
    message:
      'Do you want to set block or gas properties for this chain config?(optional)',
  });
  if (wantAdvancedConfig) {
    const wantBlockConfig = await confirm({
      message: 'Do you want to add block config for this chain?',
    });
    if (wantBlockConfig) {
      const blockConfirmation = await input({
        message:
          'Enter no. of blocks to wait before considering a transaction confirmed(0-500)',
        validate: (value) => parseInt(value) >= 0 && parseInt(value) <= 500,
      });
      const blockReorgPeriod = await input({
        message:
          'Enter no. of blocks before a transaction has a near-zero chance of reverting(0-500)',
        validate: (value) => parseInt(value) >= 0 && parseInt(value) <= 500,
      });
      const blockTimeEstimate = await input({
        message: 'Enter the rough estimate of time per block in seconds(0-20)',
        validate: (value) => parseInt(value) >= 0 && parseInt(value) <= 20,
      });
      metadata.blocks = {
        confirmations: parseInt(blockConfirmation, 10),
        reorgPeriod: parseInt(blockReorgPeriod, 10),
        estimateBlockTime: parseInt(blockTimeEstimate, 10),
      };
    }
    const wantGasConfig = await confirm({
      message: 'Do you want to add gas config for this chain?',
    });
    if (wantGasConfig) {
      const isEIP1559 = await confirm({
        message: 'Is your chain an EIP1559 enabled?',
      });
      if (isEIP1559) {
        const maxFeePerGas = await input({
          message: 'Enter the max fee per gas in gwei',
        });
        const maxPriorityFeePerGas = await input({
          message: 'Enter the max priority fee per gas in gwei',
        });
        metadata.transactionOverrides = {
          maxFeePerGas: BigInt(maxFeePerGas) * BigInt(10 ** 9),
          maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas) * BigInt(10 ** 9),
        };
      } else {
        const gasPrice = await input({
          message: 'Enter the gas price in gwei',
        });
        metadata.transactionOverrides = {
          gasPrice: BigInt(gasPrice) * BigInt(10 ** 9),
        };
      }
    }
  }
  const parseResult = ChainMetadataSchema.safeParse(metadata);
  if (parseResult.success) {
    logGreen(`Chain config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, { [name]: metadata }, format);
  } else {
    errorRed(
      `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    errorRed(JSON.stringify(parseResult.error.errors));
    throw new Error('Invalid chain config');
  }
}
