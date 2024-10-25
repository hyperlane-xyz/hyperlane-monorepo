import { ContractFactory } from 'ethers';

import {
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import {
  BuildArtifact,
  ChainMap,
  ContractVerificationInput,
  EvmERC20WarpRouteReader,
  ExplorerFamily,
  ExplorerLicenseType,
  MultiProvider,
  PostDeploymentContractVerifier,
  TokenType,
  VerificationInput,
  hypERC20contracts,
  hypERC20factories,
  isProxy,
  proxyAdmin,
  proxyImplementation,
  verificationUtils, // verificationUtils,
} from '@hyperlane-xyz/sdk';
import { Address, assert, objFilter } from '@hyperlane-xyz/utils';

import {
  CommandContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { logGray } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';

import { symbolCommandOption } from './options.js';

export const verifyContractsCommand: CommandModuleWithWriteContext<{
  symbol: string;
  buildArtifact: string;
}> = {
  command: 'verify-contract',
  describe: 'Verify deployed contracts on explorers',
  builder: {
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    buildArtifact: {
      type: 'string',
      description: 'Build Artifacts', // TODO better desc
      alias: 'b',
    },
  },
  handler: async ({ context, symbol, buildArtifact: buildArtifactPath }) => {
    const warpCoreConfig = await selectRegistryWarpRoute(
      context.registry,
      symbol,
    );

    const verificationInputs: ChainMap<VerificationInput> = {};
    for (const token of warpCoreConfig.tokens) {
      const { chainName } = token;
      const provider = context.multiProvider.getProvider(chainName);

      verificationInputs[chainName] = [];

      assert(token.addressOrDenom, 'Invalid addressOrDenom');
      const isProxyContract = await isProxy(provider, token.addressOrDenom);

      if (isProxyContract) {
        const { proxyAdminInput, transparentUpgradeableProxyInput } =
          await getProxyAndAdminInput({
            context,
            chainName,
            proxyAddress: token.addressOrDenom,
          });

        verificationInputs[chainName].push(proxyAdminInput);
        verificationInputs[chainName].push(transparentUpgradeableProxyInput);
      }

      // Implementation
      const deployedContractAddress = isProxyContract
        ? await proxyImplementation(provider, token.addressOrDenom)
        : token.addressOrDenom;

      const implementationInput = await getImplementationInput({
        context,
        chainName,
        implementationAddress: deployedContractAddress,
      });
      verificationInputs[chainName].push(implementationInput);
    }

    const apiKeys = {
      // TODO figure where to reliably fetch these
    };
    const buildArtifact: BuildArtifact = readYamlOrJson(buildArtifactPath);
    const verifier = new PostDeploymentContractVerifier(
      verificationInputs,
      context.multiProvider,
      apiKeys,
      buildArtifact,
      ExplorerLicenseType.MIT,
    );

    // TODO: below this is from infra scripts. CLEAN THIS UP.
    // verify all the things
    const failedResults = (await verifier.verify()).filter(
      (result) => result.status === 'rejected',
    );

    // only log the failed verifications to console
    if (failedResults.length > 0) {
      console.error(
        'Verification failed for the following contracts:',
        failedResults.map((result) => result),
      );
      process.exit(1);
    }

    process.exit(0);
  },
};

async function getProxyAndAdminInput({
  context,
  chainName,
  proxyAddress,
}: {
  context: CommandContext;
  chainName: string;
  proxyAddress: Address;
}): Promise<{
  proxyAdminInput: ContractVerificationInput;
  transparentUpgradeableProxyInput: ContractVerificationInput;
}> {
  const provider = context.multiProvider.getProvider(chainName);

  logGray(`Getting constructor args for ProxyAdmin on chain ${chainName}`);
  const proxyAdminAddress = await proxyAdmin(provider, proxyAddress);
  const proxyAdminConstructorArgs = await getConstructorArgs({
    context,
    chainName,
    bytecode: ProxyAdmin__factory.bytecode,
    contractAddress: proxyAdminAddress,
  });
  const proxyAdminInput = verificationUtils.buildVerificationInput(
    'ProxyAdmin',
    proxyAdminAddress,
    proxyAdminConstructorArgs,
  );

  logGray(
    `Getting constructor args for TransparentUpgradeableProxy on chain ${chainName}`,
  );
  const proxyConstructorArgs = await getConstructorArgs({
    context,
    chainName,
    contractAddress: proxyAddress,
    bytecode: TransparentUpgradeableProxy__factory.bytecode,
  });
  const transparentUpgradeableProxyInput =
    verificationUtils.buildVerificationInput(
      'TransparentUpgradeableProxy',
      proxyAddress,
      proxyConstructorArgs,
      true,
      await proxyImplementation(provider, proxyAddress),
    );

  return { proxyAdminInput, transparentUpgradeableProxyInput };
}

async function getImplementationInput({
  context,
  chainName,
  implementationAddress,
}: {
  context: CommandContext;
  chainName: string;
  implementationAddress: Address;
}) {
  const { factory, tokenType } = await getWarpRouteFactory(
    context.multiProvider,
    chainName,
    implementationAddress,
  );
  const contractName = hypERC20contracts[tokenType];

  const implementationConstructorArgs = await getConstructorArgs({
    context,
    chainName,
    bytecode: factory.bytecode,
    contractAddress: implementationAddress,
  });
  return verificationUtils.buildVerificationInput(
    contractName,
    implementationAddress,
    implementationConstructorArgs,
  );
}

async function getWarpRouteFactory(
  multiProvider: MultiProvider,
  chainName: string,
  warpRouteAddress: Address,
): Promise<{
  factory: ContractFactory;
  tokenType: Exclude<
    TokenType,
    TokenType.syntheticUri | TokenType.collateralUri
  >;
}> {
  const warpRouteReader = new EvmERC20WarpRouteReader(multiProvider, chainName);
  const tokenType = (await warpRouteReader.deriveTokenType(
    warpRouteAddress,
  )) as Exclude<TokenType, TokenType.syntheticUri | TokenType.collateralUri>;

  const factory = objFilter(
    hypERC20factories,
    (t, _contract): _contract is any => t === tokenType,
  )[tokenType];

  return { factory, tokenType };
}
/**
 * Retrieves the constructor args using the Explorer and/or RPC (eth_getTransactionByHash)
 */
async function getConstructorArgs({
  context,
  chainName,
  bytecode,
  contractAddress,
}: {
  context: CommandContext;
  chainName: string;
  bytecode: string;
  contractAddress: string;
}) {
  const { family } = context.multiProvider.getExplorerApi(chainName);

  let constructorArgs: string;
  switch (family) {
    case ExplorerFamily.Etherscan:
      constructorArgs = await getEtherscanConstructorArgs({
        context,
        chainName,
        contractAddress,
        bytecode,
      });
      break;
    case ExplorerFamily.Blockscout:
      constructorArgs = await getBlockScoutConstructorArgs({
        context,
        chainName,
        contractAddress,
      });
      break;
    default:
      throw new Error(`Explorer Family ${family} unsupported`);
  }

  return constructorArgs;
}

async function getEtherscanConstructorArgs({
  context,
  chainName,
  contractAddress,
  bytecode,
}: {
  context: CommandContext;
  chainName: string;
  contractAddress: Address;
  bytecode: string;
}): Promise<string> {
  const { apiUrl: blockExplorerApiUrl, apiKey: blockExplorerApiKey } =
    context.multiProvider.getExplorerApi(chainName);
  const url = new URL(blockExplorerApiUrl);
  url.searchParams.append('module', 'contract');
  url.searchParams.append('action', 'getcontractcreation');
  url.searchParams.append('contractaddresses', contractAddress);

  if (blockExplorerApiKey)
    // TODO figure out how to get API keys. Maybe use the existing prompt??
    url.searchParams.append('apikey', blockExplorerApiKey);

  const explorerResp = await fetch(url);
  const creationTx = (await explorerResp.json()).result[0].txHash;

  // Fetch deployment bytecode (includes constructor args)
  assert(creationTx, 'Contract creation transaction not found!');
  const rpcUrl = context.chainMetadata[chainName].rpcUrls[0].http;
  const creationTxResp = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'eth_getTransactionByHash',
      params: [creationTx],
      id: 1,
      jsonrpc: '2.0',
    }),
  });

  // Truncate the deployment bytecode
  const creationInput: string = (await creationTxResp.json()).result.input;
  return creationInput.substring(bytecode.length);
}

async function getBlockScoutConstructorArgs({
  context,
  chainName,
  contractAddress,
}: {
  context: CommandContext;
  chainName: string;
  contractAddress: Address;
}) {
  const { apiUrl: blockExplorerApiUrl } =
    context.multiProvider.getExplorerApi(chainName);

  const url = new URL(
    `/api/v2/smart-contracts/${contractAddress}`,
    blockExplorerApiUrl,
  );

  const smartContractResp = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return (await smartContractResp.json()).constructor_args;
}
