import { confirm, input } from '@inquirer/prompts';

import { ChainMetadata, ChainMetadataSchema } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen } from '../logger.js';

export async function createChainConfig({
  context,
}: {
  context: CommandContext;
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
