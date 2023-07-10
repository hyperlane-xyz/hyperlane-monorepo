import { ChainMap, Chains, chainMetadata } from '@hyperlane-xyz/sdk';

import {
  AdapterType,
  CctpAdapterConfig,
  CctpAdapterDeployer,
} from './middleware/liquidity-layer-v2/CctpAdapterDeployer';
import { MultiProvider } from './providers/MultiProvider';

const circleDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].chainId, circleDomain: 0 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].chainId, circleDomain: 1 },
];

const cctpAdapterConfigs: ChainMap<CctpAdapterConfig> = {
  [Chains.goerli]: {
    owner: '0x...',
    type: AdapterType.CCTP,
    tokenMessengerAddress: '0xd0c3da58f55358142b8d3e06c1c30c5c6114efe8',
    usdcAddress: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
    token: '0x...',
    tokenSymbol: 'USDC',
    gasAmount: 10000, // TBD
    circleDomainMapping,
    mailbox: '0x...',
    interchainGasPaymaster: '0x...',
  },
  [Chains.fuji]: {
    owner: '0x...',
    type: AdapterType.CCTP,
    tokenMessengerAddress: '0xeb08f243e5d3fcff26a9e38ae5520a669f4019d0',
    usdcAddress: '0x5425890298aed601595a70ab815c96711a31bc65',
    token: '0x...',
    tokenSymbol: 'USDC',
    gasAmount: 10000, // TBD
    circleDomainMapping,
    mailbox: '0x...',
    interchainGasPaymaster: '0x...',
  },
};

async function main() {
  const chainConfigs = { ...chainMetadata };
  const multiProvider = new MultiProvider(chainConfigs);
  const cctpAdapterDeployer = new CctpAdapterDeployer(multiProvider);
  const deployedContracts = await cctpAdapterDeployer.deploy(
    cctpAdapterConfigs,
  );
  console.log(
    `Deployed contracts: ${JSON.stringify(deployedContracts, null, 2)}`,
  );
}

main();
