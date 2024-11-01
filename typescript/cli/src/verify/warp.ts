import { ContractFactory } from 'ethers';

import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  EvmERC20WarpRouteReader,
  ExplorerLicenseType,
  MultiProvider,
  PostDeploymentContractVerifier,
  TokenType,
  VerificationInput,
  WarpCoreConfig,
  hypERC20contracts,
  hypERC20factories,
  isProxy,
  proxyImplementation,
  verificationUtils, // verificationUtils,
} from '@hyperlane-xyz/sdk';
import { Address, assert, objFilter } from '@hyperlane-xyz/utils';

import { getOrRequestApiKeys } from '../context/context.js';
import { CommandContext } from '../context/types.js';
import { logBlue, logGray, logGreen } from '../logger.js';

// Zircuit does not have an external API: https://docs.zircuit.com/dev-tools/block-explorer
const UNSUPPORTED_CHAINS = ['zircuit'];

export async function runVerifyWarpRoute({
  context,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
}) {
  const { multiProvider, chainMetadata, skipConfirmation } = context;

  const verificationInputs: ChainMap<VerificationInput> = {};

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await getOrRequestApiKeys(
      warpCoreConfig.tokens.map((t) => t.chainName),
      chainMetadata,
    );

  for (const token of warpCoreConfig.tokens) {
    const { chainName } = token;
    const { apiUrl: blockExplorerApiUrl } =
      multiProvider.getExplorerApi(chainName);
    verificationInputs[chainName] = [];

    if (UNSUPPORTED_CHAINS.includes(chainName)) {
      logBlue(`Unsupported chain ${chainName}. Skipping.`);
      continue;
    }
    assert(token.addressOrDenom, 'Invalid addressOrDenom');

    const provider = multiProvider.getProvider(chainName);
    const isProxyContract = await isProxy(provider, token.addressOrDenom);

    logGray(`Getting constructor args for ${chainName} using explorer API`);

    // Verify Implementation first because Proxy won't verify without it.
    const deployedContractAddress = isProxyContract
      ? await proxyImplementation(provider, token.addressOrDenom)
      : token.addressOrDenom;

    const { factory, tokenType } = await getWarpRouteFactory(
      multiProvider,
      chainName,
      deployedContractAddress,
    );
    const contractName = hypERC20contracts[tokenType];
    const implementationInput = await verificationUtils.getImplementationInput({
      chainName,
      contractName,
      multiProvider,
      blockExplorerApiUrl,
      blockExplorerApiKey: apiKeys[chainName],
      bytecode: factory.bytecode,
      implementationAddress: deployedContractAddress,
    });
    verificationInputs[chainName].push(implementationInput);

    // Verify Proxy and ProxyAdmin
    if (isProxyContract) {
      const { proxyAdminInput, transparentUpgradeableProxyInput } =
        await verificationUtils.getProxyAndAdminInput({
          chainName,
          multiProvider,
          blockExplorerApiUrl,
          blockExplorerApiKey: apiKeys[chainName],
          proxyAddress: token.addressOrDenom,
        });

      verificationInputs[chainName].push(proxyAdminInput);
      verificationInputs[chainName].push(transparentUpgradeableProxyInput);
    }
  }

  logBlue(`All explorer constructor args successfully retrieved. Verifying...`);
  const verifier = new PostDeploymentContractVerifier(
    verificationInputs,
    context.multiProvider,
    apiKeys,
    buildArtifact,
    ExplorerLicenseType.MIT,
  );

  await verifier.verify();

  return logGreen('Finished contract verification');
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
