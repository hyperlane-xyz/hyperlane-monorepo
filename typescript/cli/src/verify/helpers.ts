import { ContractFactory } from 'ethers';

import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  ExplorerLicenseType,
  MultiProvider,
  PostDeploymentContractVerifier,
  VerificationInput,
  isProxy,
  proxyImplementation,
  verificationUtils,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logBlue, logGray, logGreen } from '../logger.js';

export async function verifyProxyAndImplementation({
  context,
  address,
  chainName,
  apiKeys,
  getContractFactoryAndName,
}: {
  context: CommandContext;
  address: string;
  chainName: string;
  apiKeys: ChainMap<string>;
  getContractFactoryAndName: (
    multiProvider: MultiProvider,
    chainName: string,
    warpRouteAddress: Address,
  ) => Promise<{
    factory: ContractFactory;
    contractName: string;
  }>;
}) {
  const { multiProvider } = context;

  const verificationInputs: ChainMap<VerificationInput> = {};
  verificationInputs[chainName] = [];

  assert(address, 'Invalid addressOrDenom');

  const provider = multiProvider.getProvider(chainName);
  const isProxyContract = await isProxy(provider, address);

  logGray(`Getting constructor args for ${chainName} using explorer API`);

  // Verify Implementation first because Proxy won't verify without it.
  const deployedContractAddress = isProxyContract
    ? await proxyImplementation(provider, address)
    : address;

  const { factory, contractName } = await getContractFactoryAndName(
    multiProvider,
    chainName,
    deployedContractAddress,
  );

  const implementationInput = await verificationUtils.getImplementationInput({
    chainName,
    contractName,
    multiProvider,
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
        proxyAddress: address,
      });

    verificationInputs[chainName].push(proxyAdminInput);
    verificationInputs[chainName].push(transparentUpgradeableProxyInput);
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
