import { confirm, input, select } from '@inquirer/prompts';
import { ethers } from 'ethers';
import { keccak256 } from 'ethers/lib/utils.js';
import {
  Provider as StarknetProvider,
  provider as starknetProvider,
} from 'starknet';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainMetadata,
  ChainMetadataSchema,
  ChainTechnicalStack,
  EthJsonRpcBlockParameterTag,
  ExplorerFamily,
  ZChainName,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { indentYamlOrJson, readYamlOrJson } from '../utils/files.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';

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

  const protocol = (await select({
    message: 'Select the chain protocol type:',
    choices: Object.entries(ProtocolType).map(([_, value]) => ({ value })),
    pageSize: Object.entries(ProtocolType).length,
  })) as ProtocolType;

  assert(
    protocol === ProtocolType.Ethereum || protocol === ProtocolType.Starknet,
    'Protocol type not supported yet!',
  );

  const rpcUrl = await detectAndConfirmOrPrompt(
    createProtocolDefaultProviderDetector(protocol),
    'Enter http or https',
    'rpc url',
    'JSON RPC provider',
  );

  const name = await input({
    message: 'Enter chain name (one word, lower case)',
    validate: (chainName) => ZChainName.safeParse(chainName).success,
  });

  const displayName = await input({
    message: 'Enter chain display name',
    default: name[0].toUpperCase() + name.slice(1),
  });

  const chainId = formatChainIdBasedOnProtocol(
    await detectAndConfirmOrPrompt(
      createProtocolChainIdDetector(protocol, rpcUrl),
      protocol === ProtocolType.Starknet ? 'Enter a (hex)' : 'Enter a (number)',
      'chain id',
      'JSON RPC provider',
    ),
    protocol,
  );

  const isTestnet = await confirm({
    message:
      'Is this chain a testnet (a chain used for testing & development)?',
  });

  const technicalStack = (await select({
    choices: Object.entries(ChainTechnicalStack).map(([_, value]) => ({
      value,
    })),
    message: 'Select the chain technical stack',
    pageSize: 10,
  })) as ChainTechnicalStack;

  const arbitrumNitroMetadata: Pick<ChainMetadata, 'index'> = {};
  if (technicalStack === ChainTechnicalStack.ArbitrumNitro) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const indexFrom = await detectAndConfirmOrPrompt(
      async () => {
        return (await provider.getBlockNumber()).toString();
      },
      `Enter`,
      'starting block number for indexing',
      'JSON RPC provider',
    );

    arbitrumNitroMetadata.index = {
      from: parseInt(indexFrom),
    };
  }

  const metadata: ChainMetadata = {
    name,
    displayName,
    chainId,
    domainId:
      typeof chainId === 'string' ? stringChainIdToDomainId(chainId) : chainId,
    protocol: protocol,
    technicalStack,
    rpcUrls: [{ http: rpcUrl }],
    isTestnet,
    ...arbitrumNitroMetadata,
  };

  await addBlockExplorerConfig(metadata);

  await addBlockOrGasConfig(metadata);

  await addNativeTokenConfig(metadata);

  const parseResult = ChainMetadataSchema.safeParse(metadata);
  if (parseResult.success) {
    logGreen(`Chain config is valid, writing unsorted to registry:`);
    const metadataYaml = yamlStringify(metadata, {
      indent: 2,
      sortMapEntries: true,
    });
    log(indentYamlOrJson(metadataYaml, 4));
    await context.registry.updateChain({ chainName: metadata.name, metadata });
  } else {
    errorRed(
      `Chain config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/chain-config.yaml for an example`,
    );
    errorRed(JSON.stringify(parseResult.error.errors));
    throw new Error('Invalid chain config');
  }
}

async function addBlockExplorerConfig(metadata: ChainMetadata): Promise<void> {
  const wantBlockExplorerConfig = await confirm({
    default: false,
    message: 'Do you want to add a block explorer config for this chain',
  });
  if (wantBlockExplorerConfig) {
    const name = await input({
      message: 'Enter a human readable name for the explorer:',
    });
    const url = await input({
      message: 'Enter the base URL for the explorer:',
    });
    const apiUrl = await input({
      message: 'Enter the base URL for requests to the explorer API:',
    });
    const family = (await select({
      message: 'Select the type (family) of block explorer:',
      choices: Object.entries(ExplorerFamily).map(([_, value]) => ({ value })),
      pageSize: 10,
    })) as ExplorerFamily;
    const apiKey =
      (await input({
        message:
          "Optional: Provide an API key for the explorer, or press 'enter' to skip. Please be sure to remove this field if you intend to add your config to the Hyperlane registry:",
      })) ?? undefined;
    metadata.blockExplorers = [];
    metadata.blockExplorers[0] = {
      name,
      url,
      apiUrl,
      family,
    };
    if (apiKey) metadata.blockExplorers[0].apiKey = apiKey;
  }
}

async function addBlockOrGasConfig(metadata: ChainMetadata): Promise<void> {
  const wantBlockOrGasConfig = await confirm({
    default: false,
    message: 'Do you want to set block or gas properties for this chain config',
  });
  if (wantBlockOrGasConfig) {
    await addBlockConfig(metadata);
    await addGasConfig(metadata);
  }
}

async function addBlockConfig(metadata: ChainMetadata): Promise<void> {
  const parseReorgPeriod = (
    value: string,
  ): number | EthJsonRpcBlockParameterTag => {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? (value as EthJsonRpcBlockParameterTag) : parsed;
  };

  const wantBlockConfig = await confirm({
    message: 'Do you want to add block config for this chain',
  });
  if (wantBlockConfig) {
    const blockConfirmation = await input({
      message:
        'Enter no. of blocks to wait before considering a transaction confirmed (0-500):',
      validate: (value) => parseInt(value) >= 0 && parseInt(value) <= 500,
    });
    const blockReorgPeriod = await input({
      message:
        'Enter no. of blocks before a transaction has a near-zero chance of reverting (0-500) or block tag (earliest, latest, safe, finalized, pending):',
      validate: (value) => {
        const parsedInt = parseInt(value, 10);
        return (
          Object.values(EthJsonRpcBlockParameterTag).includes(
            value as EthJsonRpcBlockParameterTag,
          ) ||
          (!isNaN(parsedInt) && parsedInt >= 0 && parsedInt <= 500)
        );
      },
    });
    const blockTimeEstimate = await input({
      message: 'Enter the rough estimate of time per block in seconds (0-20):',
      validate: (value) => parseInt(value) >= 0 && parseInt(value) <= 20,
    });
    metadata.blocks = {
      confirmations: parseInt(blockConfirmation, 10),
      reorgPeriod: parseReorgPeriod(blockReorgPeriod),
      estimateBlockTime: parseInt(blockTimeEstimate, 10),
    };
  }
}

async function addGasConfig(metadata: ChainMetadata): Promise<void> {
  const wantGasConfig = await confirm({
    message: 'Do you want to add gas config for this chain',
  });
  if (wantGasConfig) {
    const isEIP1559 = await confirm({
      message: 'Is your chain an EIP1559 enabled',
    });
    if (isEIP1559) {
      const maxFeePerGas = await input({
        message: 'Enter the max fee per gas (gwei):',
      });
      const maxPriorityFeePerGas = await input({
        message: 'Enter the max priority fee per gas (gwei):',
      });
      metadata.transactionOverrides = {
        maxFeePerGas: BigInt(maxFeePerGas) * BigInt(10 ** 9),
        maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas) * BigInt(10 ** 9),
      };
    } else {
      const gasPrice = await input({
        message: 'Enter the gas price (gwei):',
      });
      metadata.transactionOverrides = {
        gasPrice: BigInt(gasPrice) * BigInt(10 ** 9),
      };
    }
  }
}

async function addNativeTokenConfig(metadata: ChainMetadata): Promise<void> {
  const wantNativeConfig = await confirm({
    default: false,
    message:
      'Do you want to set native token properties for this chain config (defaults to ETH)',
  });
  let symbol, name, decimals, denom;
  if (wantNativeConfig) {
    symbol = await input({
      message: "Enter the native token's symbol:",
    });
    name = await input({
      message: `Enter the native token's name:`,
    });
    decimals = await input({
      message: "Enter the native token's decimals:",
    });
    denom = await input({
      message: "Enter the native token's address:",
    });
  }

  metadata.nativeToken = {
    symbol: symbol ?? 'ETH',
    name: name ?? 'Ether',
    decimals: decimals ? parseInt(decimals, 10) : 18,
    denom: denom ?? undefined,
  };
}

function createProtocolDefaultProviderDetector(
  protocol: ProtocolType.Ethereum | ProtocolType.Starknet,
) {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return async () => {
        return ethers.providers.JsonRpcProvider.defaultUrl();
      };
    case ProtocolType.Starknet:
      return async () => {
        return starknetProvider.getDefaultNodeUrl();
      };
  }
}

function createProtocolChainIdDetector(
  protocol: ProtocolType.Ethereum | ProtocolType.Starknet,
  rpcUrl: string,
) {
  return async () => {
    switch (protocol) {
      case ProtocolType.Ethereum: {
        const network = await new ethers.providers.JsonRpcProvider(
          rpcUrl,
        ).getNetwork();
        return network.chainId.toString();
      }
      case ProtocolType.Starknet:
        return new StarknetProvider({ nodeUrl: rpcUrl }).getChainId();
    }
  };
}

function formatChainIdBasedOnProtocol(chainId: string, protocol: ProtocolType) {
  if (protocol === ProtocolType.Starknet) return chainId;
  return parseInt(chainId, 10);
}

//TODO: move this to somewhere else
function stringChainIdToDomainId(chainId: string): number {
  return parseInt(keccak256(chainId).slice(0, 8));
}
