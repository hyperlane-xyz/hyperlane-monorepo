import { BigNumber } from 'ethers';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../../../src/agents';
import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';

export async function getChain(environment: string, deployerKeySecretName: string) {
  const name = ChainName.GORLI;
  const chainJson: ChainConfigJson = {
    name,
    rpc: await getSecretRpcEndpoint(environment, name),
    deployerKey: await getSecretDeployerKey(deployerKeySecretName),
    domain: 5,
    confirmations: 3,
    gasPrice: BigNumber.from(10_000_000_000),
    weth: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6',
  };
  return new ChainConfig(chainJson);
}
