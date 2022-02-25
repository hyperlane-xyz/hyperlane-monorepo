import { getSecretRpcEndpoint } from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import { fetchGCPSecret } from '../../../src/utils/gcloud';

export async function getChain(environment: string, deployerKeySecretName: string) {
  const name = ChainName.CELO;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await fetchGCPSecret(deployerKeySecretName, false),
    domain: 0x63656c6f, // b'celo' interpreted as an int
    updaterInterval: 300,
    updaterPause: 15,
  };
  return new ChainConfig(chainJson);
}
