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
  const name = ChainName.POLYGON;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await getSecretDeployerKey(deployerKeySecretName),
    domain: 0x706f6c79, // b'poly' interpreted as an int
    gasPrice: '5000000000', // 50 gwei
    weth: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // Actually WMATIC but ok
    updaterInterval: 300,
  };
  return new ChainConfig(chainJson);
}
