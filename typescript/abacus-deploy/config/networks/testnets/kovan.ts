import { BigNumber } from 'ethers';
import { getSecretRpcEndpoint } from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import { fetchGCPSecret } from '../../../src/utils/gcloud';

export async function getChain(environment: string, deployerKeySecretName: string) {
  const name = ChainName.KOVAN;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await fetchGCPSecret(deployerKeySecretName, false),
    domain: 3000,
    gasPrice: BigNumber.from(10_000_000_000),
    weth: '0xd0a1e359811322d97991e03f863a0c30c2cf029c',
  };
  return new ChainConfig(chainJson);
}
