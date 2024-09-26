import { Provider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { getChain } from '../../config/registry.js';
import { getEnvironmentConfig } from '../core-utils.js';

import lzChainDeployments from './lz-chain-deployments.json';
import stargateChainOApps from './stargate-chains.json';

function translateLzChain(lzChain: string) {
  let translated = lzChain.replace('-', '');

  const optionalTranslationMap: Record<string, string> = {
    zora: 'zoramainnet',
    zkevm: 'polygonzkevm',
    // Because the strategy is to look at each chains endpoint, we skip solana
    // 'solana': 'solanamainnet',
    manta: 'mantapacific',
  };
  if (optionalTranslationMap[translated]) {
    translated = optionalTranslationMap[translated];
  }
  return translated;
}

async function main() {
  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider();

  const chainIntersection = Object.keys(stargateChainOApps).filter(
    (lzChain) => {
      const lzChainTranslated = translateLzChain(lzChain);
      return envConfig.supportedChainNames.includes(lzChainTranslated);
    },
  );
  const ourUnsupportedChains = Object.keys(stargateChainOApps).filter(
    (stargateChain) => {
      const stargateChainTranslated = translateLzChain(stargateChain);
      return !envConfig.supportedChainNames.includes(stargateChainTranslated);
    },
  );

  console.log('Supported chains:', JSON.stringify(chainIntersection, null, 2));
  console.log(
    'Unsupported chains:',
    JSON.stringify(ourUnsupportedChains, null, 2),
  );

  const results = await Promise.all(
    chainIntersection.map(async (stargateChain) => {
      const { hyperlaneConfirmations, stargateConfirmations, lzConfirmations } =
        await getHyperlaneAndStargateConfirmations(
          multiProvider,
          stargateChain,
        );
      const hyperlaneChain = translateLzChain(stargateChain);
      return {
        chain: hyperlaneChain,
        hyperlaneConfirmations,
        stargateConfirmations,
        lzConfirmations,
      };
    }),
  );
  console.table(results, [
    'chain',
    'hyperlaneConfirmations',
    'stargateConfirmations',
    'lzConfirmations',
  ]);
}

async function getHyperlaneAndStargateConfirmations(
  multiProvider: MultiProvider,
  stargateChain: string,
) {
  const hyperlaneChain = translateLzChain(stargateChain);
  const provider = multiProvider.getProvider(hyperlaneChain);

  const hyperlaneConfirmations =
    getChain(hyperlaneChain).blocks?.reorgPeriod ?? -1;

  const OAppAddress =
    stargateChainOApps[stargateChain as keyof typeof stargateChainOApps][
      'TokenMessaging'
    ];

  const stargateConfirmations = await getDefaultConfirmations(
    provider,
    stargateChain,
    OAppAddress,
  );

  const lzConfirmations = await getDefaultConfirmations(
    provider,
    hyperlaneChain,
    ethers.constants.AddressZero,
  );

  return { hyperlaneConfirmations, stargateConfirmations, lzConfirmations };
}

async function getDefaultConfirmations(
  provider: Provider,
  originChain: string,
  OAppAddress: string,
) {
  const lzChainLookup = originChain as keyof typeof lzChainDeployments;
  const sendLib = lzChainDeployments[lzChainLookup].sendUln302;

  const endpoint = lzEndpointContract(provider, originChain);
  // Just always choose arbitrum as the dest chain, unless the origin is arbitrum in which case choose avalanche
  const destChain = originChain == 'arbitrum' ? 30210 : 30106;
  // 2 for ulnconfig
  const config = await endpoint.getConfig(OAppAddress, sendLib, destChain, 2);
  const ulnConfigStructType = [
    'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)',
  ];
  const sendUlnConfigArray = ethers.utils.defaultAbiCoder.decode(
    ulnConfigStructType,
    config,
  );
  return sendUlnConfigArray[0].confirmations.toNumber();
}

function lzEndpointContract(provider: Provider, originLzChain: string) {
  const lzChainLookup = originLzChain as keyof typeof lzChainDeployments;
  const lzEndpoint = lzChainDeployments[lzChainLookup].endpointV2;

  const ethereumLzEndpointABI = [
    'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) external view returns (bytes memory config)',
  ];
  return new ethers.Contract(lzEndpoint, ethereumLzEndpointABI, provider);
}

main();
