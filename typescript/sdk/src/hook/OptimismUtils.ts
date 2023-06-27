import type { Chain as WagmiChain } from '@wagmi/chains';
import { createTestClient, http } from 'viem';
import { avalanche } from 'viem/chains';

export const opForked = {
  id: 10,
  name: 'Anvil Forked',
  network: 'opForked',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    public: { http: ['http://127.0.0.1:8545'] },
    default: { http: ['http://127.0.0.1:8545'] },
  },
  blockExplorers: {
    etherscan: { name: 'Etherscan', url: 'https://etherscan.io' },
    default: { name: 'Etherscan', url: 'https://etherscan.io' },
  },
};

// import { OptimismISM__factory } from '@hyperlane-xyz/core';

export const testClient = createTestClient({
  chain: avalanche,
  mode: 'anvil',
  transport: http(),
});

async function setISMStorage(): Promise<WagmiChain> {
  const result = await testClient.setStorageAt({
    address: '0xe846c6fcf817734ca4527b28ccb4aea2b6663c79',
    index: 2,
    value: '0x0000000000000000000000000000000000000000000000000000000000000069',
  });

  console.log(result);
}

setISMStorage()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
