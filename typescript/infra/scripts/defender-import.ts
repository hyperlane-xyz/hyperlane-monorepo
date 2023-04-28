import { AdminClient, Contract } from 'defender-admin-client';

import { CoreChainName, hyperlaneEnvironments } from '@hyperlane-xyz/sdk';

import { fetchGCPSecret } from '../src/utils/gcloud';

function hypToOzNetwork(network: CoreChainName): Contract['network'] {
  switch (network) {
    case 'ethereum':
      return 'mainnet';
    case 'arbitrumgoerli':
      return 'arbitrum-goerli';
    case 'optimismgoerli':
      return 'optimism-goerli';
    case 'polygon':
      return 'matic';
    case 'gnosis':
      return 'xdai';
    case 'bsctestnet':
    case 'sepolia':
    case 'moonbasealpha':
    case 'test1':
    case 'test2':
    case 'test3':
      throw new Error('Defender not used for testnets');
    default:
      return network;
  }
}

// proxy admin is inferred from EIP1967 slot
const INCLUDE_CONTRACTS = ['mailbox', 'multisigIsm'];

async function importContracts() {
  const { apiKey, secretKey } = await fetchGCPSecret('openzeppelin-defender');
  const client = new AdminClient({ apiKey, apiSecret: secretKey });

  const mainnet = hyperlaneEnvironments.mainnet;
  for (const [network, contracts] of Object.entries(mainnet)) {
    const ozNetwork = hypToOzNetwork(network as CoreChainName);
    for (const [name, address] of Object.entries(contracts).filter(([name]) =>
      INCLUDE_CONTRACTS.includes(name),
    )) {
      const ozName = `${network}-${name}`;
      console.log(`Adding ${ozName} at ${address}`);
      await client.addContract({
        network: ozNetwork,
        address: address,
        name: ozName,
      });
    }
  }
}

importContracts().then().catch();
