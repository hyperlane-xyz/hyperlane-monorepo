import { getSecretDeployerKey, getSecretRpcEndpoint } from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';

export async function getChain(environment: string, deployerKeySecretName: string) {
  const name = ChainName.ETHEREUM;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await getSecretDeployerKey(deployerKeySecretName),
    domain: 0x657468, // b'eth' interpreted as an int
    // This isn't actually used because Ethereum supports EIP 1559 - but just in case
    gasPrice: '400000000000', // 400 gwei
    // EIP 1559 params
    maxFeePerGas: '300000000000', // 300 gwei
    maxPriorityFeePerGas: '4000000000', // 4 gwei
    weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    updaterInterval: 300,
  };
  return new ChainConfig(chainJson);
}
