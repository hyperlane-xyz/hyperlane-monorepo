import { BigNumber } from 'ethers';
import {
  getSecretDeployerKey,
  getSecretRpcEndpoint,
} from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';

export async function getChain(
  environment: string,
  deployerKeySecretName: string,
) {
  const name = ChainName.AVALANCHE;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await getSecretDeployerKey(deployerKeySecretName),
    domain: 0x61766178, // b'avax' interpreted as an int
    // This isn't actually used because Avalanche supports EIP 1559 - but just in case
    gasPrice: BigNumber.from(50_000_000_000), // 50 nAVAX (50 gwei)
    // EIP 1559 params
    maxFeePerGas: '50000000000', // 50 nAVAX (50 gwei)
    maxPriorityFeePerGas: '10000000000', // 10 nAVAX (10 gwei)
    weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Actually WAVAX but ok
    validatorInterval: 300,
  };
  return new ChainConfig(chainJson);
}
