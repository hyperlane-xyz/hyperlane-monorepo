import { ContractFactory } from 'ethers';

import {
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  ContractVerificationInput,
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
  proxyAdmin,
  proxyImplementation,
  verificationUtils, // verificationUtils,
} from '@hyperlane-xyz/sdk';
import { Address, assert, objFilter } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logBlue, logGray, logGreen } from '../logger.js';

export async function runVerifyWarpRoute({
  context,
  warpCoreConfig,
  apiKeys,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
  apiKeys: any;
}) {
  const verificationInputs: ChainMap<VerificationInput> = {};
  for (const token of warpCoreConfig.tokens) {
    const { chainName } = token;

    // Zircuit does not have an external API: https://docs.zircuit.com/dev-tools/block-explorer
    if (chainName === 'zircuit') {
      logBlue(
        `Skipping verification for ${chainName} due to unsupported chain.`,
      );
      continue;
    }
    assert(token.addressOrDenom, 'Invalid addressOrDenom');

    verificationInputs[chainName] = [];

    const provider = context.multiProvider.getProvider(chainName);
    const isProxyContract = await isProxy(provider, token.addressOrDenom);

    logGray(`Getting constructor args for ${chainName} using explorer API`);

    // Verify Implementation first because Proxy won't verify without it.
    const deployedContractAddress = isProxyContract
      ? await proxyImplementation(provider, token.addressOrDenom)
      : token.addressOrDenom;

    const implementationInput = await getImplementationInput({
      context,
      chainName,
      implementationAddress: deployedContractAddress,
    });
    verificationInputs[chainName].push(implementationInput);

    // Verify Proxy and ProxyAdmin
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

  logGreen('Finished contract verification');
}

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

  const proxyAdminAddress = await proxyAdmin(provider, proxyAddress);
  const proxyAdminConstructorArgs =
    await verificationUtils.getConstructorArgumentsApi({
      multiProvider: context.multiProvider,
      chainName,
      bytecode: ProxyAdmin__factory.bytecode,
      contractAddress: proxyAdminAddress,
    });
  const proxyAdminInput = verificationUtils.buildVerificationInput(
    'ProxyAdmin',
    proxyAdminAddress,
    proxyAdminConstructorArgs,
  );

  const proxyConstructorArgs =
    await verificationUtils.getConstructorArgumentsApi({
      multiProvider: context.multiProvider,
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

  const implementationConstructorArgs =
    await verificationUtils.getConstructorArgumentsApi({
      multiProvider: context.multiProvider,
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
