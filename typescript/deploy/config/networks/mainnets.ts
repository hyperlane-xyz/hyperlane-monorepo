import { BigNumber } from 'ethers';
import { ChainName } from '@abacus-network/sdk'
import { TransactionConfig } from '../../src/config/chain';

export const celo: TransactionConfig = {
  overrides: {},
};

export const ethereum: TransactionConfig = {
  overrides: {
    // This isn't actually used because Ethereum supports EIP 1559 - but just in case
    gasPrice: '400000000000', // 400 gwei
    // EIP 1559 params
    maxFeePerGas: '300000000000', // 300 gwei
    maxPriorityFeePerGas: '4000000000', // 4 gwei
  },
};

export const avalanche: TransactionConfig = {
  overrides: {
    // This isn't actually used because Avalanche supports EIP 1559 - but just in case
    gasPrice: BigNumber.from(50_000_000_000), // 50 nAVAX (50 gwei)
    // EIP 1559 params
    maxFeePerGas: '50000000000', // 50 nAVAX (50 gwei)
    maxPriorityFeePerGas: '10000000000', // 10 nAVAX (10 gwei)
  },
};

export const polygon: TransactionConfig = {
  overrides: {
    gasPrice: '5000000000', // 50 gwei
  },
};

export const configs: Partial<Record<ChainName, TransactionConfig>> = {
  celo, ethereum, avalanche, polygon
}
