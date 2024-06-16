import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMetadata,
  ChainMetadataSchema,
  ZChainName,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { detectAndConfirmOrPrompt } from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';

export function readChainConfigs(filePath: string) {
  log(`Reading file configs in ${filePath}`);
  const chainMetadata = readYamlOrJson<ChainMetadata>(filePath);

  if (
    !chainMetadata ||
    typeof chainMetadata !== 'object' ||
    !Object.keys(chainMetadata).length
  ) {
    errorRed(`No configs found in ${filePath}`);
    process.exit(1);
  }

  // Validate configs from file and merge in core configs as needed
  const parseResult = ChainMetadataSchema.safeParse(chainMetadata);
  if (!parseResult.success) {
    errorRed(
      `Chain config for ${filePath} is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    errorRed(JSON.stringify(parseResult.error.errors));
    process.exit(1);
  }
  return chainMetadata;
}

export async function createChainConfig({
  context,
}: {
  context: CommandContext;
}) {
  logBlue('Creating a new chain config');

  const rpcUrl = await detectAndConfirmOrPrompt(
    async () => {
      await new ethers.providers.JsonRpcProvider().getNetwork();
      return ethers.providers.JsonRpcProvider.defaultUrl();
    },
    'Enter http or https',
    'rpc url',
    'JSON RPC provider',
  );
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const name = await input({
    message: 'Enter chain name (one word, lower case)',
    validate: (chainName) => ZChainName.safeParse(chainName).success,
  });

  const displayName = await input({
    message: 'Enter chain display name',
    default: name[0].toUpperCase() + name.slice(1),
  });

  const chainId = parseInt(
    await detectAndConfirmOrPrompt(
      async () => {
        const network = await provider.getNetwork();
        return network.chainId.toString();
      },
      'Enter a (number)',
      'chain id',
      'JSON RPC provider',
    ),
    10,
  );

  const metadata: ChainMetadata = {
    name,
    displayName,
    chainId,
    domainId: chainId,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: rpcUrl }],
  };

  const wantAdvancedConfig = await confirm({
    default: false,
    message:
      'Do you want to set block or gas properties for this chain config?',
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
    logGreen(`Chain config is valid, writing to registry`);
    await context.registry.updateChain({ chainName: metadata.name, metadata });
  } else {
    errorRed(
      `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    errorRed(JSON.stringify(parseResult.error.errors));
    throw new Error('Invalid chain config');
  }
}
