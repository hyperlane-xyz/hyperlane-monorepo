import { TransactionRequest } from '@ethersproject/abstract-provider/src.ts';
import { Provider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { formatEther } from 'ethers/lib/utils';

import {
  ChainName,
  Chains,
  ProtocolType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts';
import { AgentAwsKey } from '../src/agents/aws';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import { AgentContextConfig } from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { Role } from '../src/roles';

import { getAgentConfig, getEnvironmentConfig } from './utils';

// const ENVIRONMENTS: DeployEnvironment[] = ['mainnet2', 'testnet3'];
// const ENVIRONMENTS: DeployEnvironment[] = ['testnet3'];

const L2Chains: ChainName[] = [
  Chains.optimism,
  Chains.optimismgoerli,
  Chains.arbitrum,
  Chains.arbitrumgoerli,
];

async function main() {
  // for (const ctx of Object.values(Contexts)) {
  //   for (const env of ENVIRONMENTS) {
  //     await transferForEnv(ctx, env);
  //   }
  // }
  const envConfig = getEnvironmentConfig('testnet3');
  const agentConfig = getAgentConfig(Contexts.Hyperlane, envConfig);
  const from = new OldRelayerAwsKey(agentConfig, Chains.fuji);
  const to = getCloudAgentKey(agentConfig, Role.Relayer);
  const provider = await fetchProvider('testnet3', Chains.optimismgoerli);

  await Promise.all([from.fetch(), to.fetch()]);
  await transfer(Chains.optimismgoerli, agentConfig, provider, from, to);
}

// async function transferForEnv(ctx: Contexts, env: DeployEnvironment) {
//   const envConfig = getEnvironmentConfig(env);
//   const agentConfig = getAgentConfig(ctx, envConfig);
//
//   // always fund from the current context and relayer role to the new relayer key
//   const multiProvider = await envConfig.getMultiProvider(
//     ctx,
//     Role.Relayer,
//     AgentConnectionType.Http,
//   );
//
//   const toKey = getCloudAgentKey(agentConfig, Role.Relayer);
//   await toKey.fetch();
//
//   const chainsForEnv = Object.keys(envConfig.chainMetadataConfigs).filter(
//     (chain) => chainMetadata[chain].protocol == ProtocolType.Ethereum,
//   );
//   for (const originChain of chainsForEnv) {
//     try {
//       const fromKey = new OldRelayerAwsKey(agentConfig, originChain);
//       await fromKey.fetch();
//       for (const chain of chainsForEnv) {
//         await transfer(chain, agentConfig, multiProvider, fromKey, toKey);
//       }
//       await fromKey.delete();
//       console.log('Deleted key', {
//         from: fromKey.identifier,
//         fromKey: fromKey.address,
//       });
//     } catch (err) {
//       console.error('Error transferring funds', {
//         ctx,
//         env,
//         originChain,
//         err,
//       });
//     }
//   }
// }

async function transfer(
  chain: ChainName,
  agentConfig: AgentContextConfig,
  provider: Provider,
  fromKey: CloudAgentKey,
  toKey: CloudAgentKey,
) {
  if (chainMetadata[chain].protocol != ProtocolType.Ethereum) return;
  const signer = await fromKey.getSigner(provider);
  const logCtx: any = {
    chain,
    from: fromKey.identifier,
    fromKey: fromKey.address,
    to: toKey.identifier,
    toKey: toKey.address,
  };
  console.log('Processing key', logCtx);

  const transferTx: TransactionRequest = {
    from: fromKey.address,
    to: toKey.address,
    value: BigNumber.from(0),
  };

  console.debug('Estimating gas');
  const gasToTransfer = await provider.estimateGas(transferTx);

  console.debug('Getting gas price');
  const [gasPrice, initialBalance] = await Promise.all([
    provider.getGasPrice(),
    provider.getBalance(fromKey.address),
  ]);

  let costToTransfer = gasToTransfer.mul(gasPrice);

  if (L2Chains.includes(chain))
    // L2 chains have a gateway fee
    costToTransfer = costToTransfer.mul(2);

  if (costToTransfer.gt(initialBalance)) {
    console.log('Not enough funds to transfer', {
      ...logCtx,
      balance: formatEther(initialBalance),
    });
    return;
  }

  // transferTx.value = initialBalance.sub(costToTransfer);
  transferTx.value = BigNumber.from(1);
  transferTx.gasLimit = gasToTransfer;
  // transferTx.maxFeePerGas = gasPrice;

  console.debug('Sending transaction');
  const receipt = await signer.sendTransaction(transferTx);

  // let receipt;
  // try {
  //   receipt = await multiProvider.sendTransaction(chain, transferTx);
  // } catch (err) {
  //   console.debug('Sending transaction failed, retrying with gasPrice', err);
  //   delete transferTx.maxFeePerGas;
  //   transferTx.gasPrice = gasPrice;
  //   receipt = await multiProvider.sendTransaction(chain, transferTx);
  // }
  console.log('Transferred funds', {
    ...logCtx,
    initialBalance: formatEther(initialBalance),
    transferred: formatEther(transferTx.value),
    cost: formatEther(costToTransfer),
    transferTx,
    receipt,
  });
}

class OldRelayerAwsKey extends AgentAwsKey {
  constructor(config: AgentContextConfig, chainName: ChainName) {
    super(config, Role.Relayer, chainName);
  }

  get identifier(): string {
    return `alias/${this.context}-${this.environment}-key-${this.chainName}-${this.role}`;
  }
}

main().then(console.log).catch(console.error);
