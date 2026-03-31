import Safe, {
  SafeAccountConfig,
  ContractNetworksConfig,
} from '@safe-global/protocol-kit';
import {
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployment,
  getSafeL2SingletonDeployment,
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
  getCompatibilityFallbackHandlerDeployment,
  getSignMessageLibDeployment,
  getCreateCallDeployment,
  getSimulateTxAccessorDeployment,
} from '@safe-global/safe-deployments';
import { BigNumber } from 'ethers';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSigners } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import { getArgs, withChainRequired, withThreshold } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const DEFAULT_SAFE_HOME_URL = 'https://app.safe.global';

const SAFE_VERSION = '1.3.0';

// Overrides for chains not in the @safe-global/safe-deployments package.
const safeContractOverrides: Record<string, ContractNetworksConfig[string]> = {
  // igra
  '38833': {
    safeSingletonAddress: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
    safeProxyFactoryAddress: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
    multiSendAddress: '0x218543288004CD07832472D464648173c77D7eB7',
    multiSendCallOnlyAddress: '0xA83c336B20401Af773B6219BA5027174338D1836',
    fallbackHandlerAddress: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
    signMessageLibAddress: '0x4FfeF8222648872B3dE295Ba1e49110E61f5b5aa',
    createCallAddress: '0x2Ef5ECfbea521449E4De05EDB1ce63B75eDA90B4',
    simulateTxAccessorAddress: '0x07EfA797c55B5DdE3698d876b277aBb6B893654C',
  },
};

function getAddress(
  deployment: ReturnType<typeof getMultiSendDeployment>,
  chainId: string,
): string | undefined {
  return deployment?.networkAddresses[chainId] ?? deployment?.defaultAddress;
}

function getRequiredAddress(
  deployment: ReturnType<typeof getMultiSendDeployment>,
  chainId: string,
  contractName: string,
): string {
  const address = getAddress(deployment, chainId);
  assert(
    address,
    `No ${contractName} deployment found for chain ${chainId} in @safe-global/safe-deployments. Add a full chain entry to safeContractOverrides to bypass.`,
  );
  return address;
}

function getContractNetworks(chainId: string): ContractNetworksConfig {
  if (safeContractOverrides[chainId]) {
    return { [chainId]: safeContractOverrides[chainId] };
  }

  return {
    [chainId]: {
      safeSingletonAddress: getRequiredAddress(
        getSafeL2SingletonDeployment({
          version: SAFE_VERSION,
          network: chainId,
        }) ??
          getSafeSingletonDeployment({
            version: SAFE_VERSION,
            network: chainId,
          }),
        chainId,
        'SafeSingleton',
      ),
      safeProxyFactoryAddress: getRequiredAddress(
        getProxyFactoryDeployment({ version: SAFE_VERSION, network: chainId }),
        chainId,
        'ProxyFactory',
      ),
      multiSendAddress: getAddress(
        getMultiSendDeployment({ version: SAFE_VERSION, network: chainId }),
        chainId,
      ),
      multiSendCallOnlyAddress: getAddress(
        getMultiSendCallOnlyDeployment({
          version: SAFE_VERSION,
          network: chainId,
        }),
        chainId,
      ),
      fallbackHandlerAddress: getAddress(
        getCompatibilityFallbackHandlerDeployment({
          version: SAFE_VERSION,
          network: chainId,
        }),
        chainId,
      ),
      signMessageLibAddress: getAddress(
        getSignMessageLibDeployment({
          version: SAFE_VERSION,
          network: chainId,
        }),
        chainId,
      ),
      createCallAddress: getAddress(
        getCreateCallDeployment({ version: SAFE_VERSION, network: chainId }),
        chainId,
      ),
      simulateTxAccessorAddress: getAddress(
        getSimulateTxAccessorDeployment({
          version: SAFE_VERSION,
          network: chainId,
        }),
        chainId,
      ),
    },
  };
}

async function main() {
  const { chain, safeHomeUrl, threshold, governanceType, saltNonce } =
    await withGovernanceType(
      withThreshold(withChainRequired(getArgs()))
        .string('safeHomeUrl')
        .describe('safeHomeUrl', 'Safe web UI base URL')
        .default('safeHomeUrl', DEFAULT_SAFE_HOME_URL)
        .string('saltNonce')
        .describe(
          'saltNonce',
          'Salt nonce for deterministic Safe address (use when signers overlap with another governance type)',
        ),
    ).argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chain],
  );

  const { signers, threshold: defaultThreshold } =
    getGovernanceSigners(governanceType);
  const safeAccountConfig: SafeAccountConfig = {
    owners: signers,
    threshold: threshold ?? defaultThreshold,
  };

  const chainId = `${multiProvider.getEvmChainId(chain)}`;
  const contractNetworks = getContractNetworks(chainId);

  // @ts-ignore
  const safe = await Safe.init({
    provider: multiProvider.getChainMetadata(chain).rpcUrls[0].http,
    predictedSafe: {
      safeAccountConfig,
      safeDeploymentConfig: saltNonce ? { saltNonce } : undefined,
    },
    contractNetworks,
  });

  const { to, data, value } = await safe.createSafeDeploymentTransaction();
  await multiProvider.sendTransaction(chain, {
    to,
    data,
    value: BigNumber.from(value),
  });

  const safeAddress = await safe.getAddress();

  rootLogger.info(`Safe address: ${safeAddress}`);
  rootLogger.info(`Safe url: ${safeHomeUrl}/home?safe=${chain}:${safeAddress}`);
  rootLogger.info('Please confirm the safe is created by following the link');
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
