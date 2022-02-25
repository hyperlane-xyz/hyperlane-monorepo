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
  const name = ChainName.RINKEBY;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await getSecretDeployerKey(deployerKeySecretName),
    domain: 2000,
    confirmations: 3,
    weth: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
  };
  return new ChainConfig(chainJson);
}
