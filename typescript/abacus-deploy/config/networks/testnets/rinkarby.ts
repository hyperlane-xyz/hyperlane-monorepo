import { getSecretRpcEndpoint } from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import { fetchGCPSecret } from '../../../src/utils/gcloud';

export async function getChain(environment: string, deployerKeySecretName: string) {
  const name = ChainName.RINKARBY;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await fetchGCPSecret(deployerKeySecretName, false),
    domain: 4000,
    gasPrice: 0,
    gasLimit: 600_000_000,
    // weth: 'TODO',
  };
  return new ChainConfig(chainJson);
}
