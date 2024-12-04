import { ContractFactory } from 'ethers';

import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainMap,
  EvmIsmReader,
  ExplorerLicenseType,
  MultiProvider,
  PostDeploymentContractVerifier,
  VerificationInput,
  isProxy,
  ismContracts,
  ismFactories,
  proxyImplementation,
  verificationUtils,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/context.js';
import { CommandContext } from '../context/types.js';
import { logBlue, logGray, logGreen } from '../logger.js';

export async function runVerifyIsm({
  context,
  address,
  chainName,
}: {
  context: CommandContext;
  address: Address;
  chainName: string;
}) {
  console.log('address', address);
  console.log('chainName', chainName);
  const { multiProvider, chainMetadata, registry, skipConfirmation } = context;

  const verificationInputs: ChainMap<VerificationInput> = { [chainName]: [] };

  let apiKeys: ChainMap<string> = {};

  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chainName], chainMetadata, registry);

  const provider = multiProvider.getProvider(chainName);
  const isProxyContract = await isProxy(provider, address);
  console.log('isProxyContract', isProxyContract);
  logGray(`Getting constructor args for ${chainName} using explorer API`);

  const deployedContractAddress = isProxyContract
    ? await proxyImplementation(provider, address)
    : address;

  const { factory, ismType } = await getIsmFactory(
    multiProvider,
    deployedContractAddress,
    chainName,
  );

  const contractName = ismContracts[ismType];

  const implementationInput = await verificationUtils.getImplementationInput({
    chainName,
    contractName,
    multiProvider,
    bytecode: factory.bytecode,
    implementationAddress: address,
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

  console.log('verificationInputs', verificationInputs);
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

async function getIsmFactory(
  multiProvider: MultiProvider,
  address: Address,
  chainName: string,
): Promise<{
  factory: ContractFactory;
  ismType: keyof typeof ismContracts;
}> {
  const ismReader = new EvmIsmReader(multiProvider, chainName);
  const { type: ismType } = await ismReader.deriveIsmConfig(address);

  const factory = objFilter(
    ismFactories,
    (t, _contract): _contract is any => t === ismType,
  )[ismType];

  return { factory, ismType };
}
