import { BigNumber, PopulatedTransaction } from 'ethers';
import { formatEther } from 'ethers/lib/utils';

import {
  AgentConnectionType,
  ChainName,
  MultiProvider,
  ProtocolType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts';
import { AgentAwsKey } from '../src/agents/aws';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import { AgentContextConfig, DeployEnvironment } from '../src/config';
import { Role } from '../src/roles';

import { getAgentConfig, getEnvironmentConfig } from './utils';

// const ENVIRONMENTS: DeployEnvironment[] = ['mainnet2', 'testnet3'];
const ENVIRONMENTS: DeployEnvironment[] = ['testnet3'];

async function main() {
  for (const ctx of Object.values(Contexts)) {
    for (const env of ENVIRONMENTS) {
      await transferForEnv(ctx, env);
    }
  }
}

async function transferForEnv(ctx: Contexts, env: DeployEnvironment) {
  const envConfig = getEnvironmentConfig(env);
  const agentConfig = getAgentConfig(ctx, envConfig);

  // always fund from the current context and relayer role to the new relayer key
  const multiProvider = await envConfig.getMultiProvider(
    ctx,
    Role.Relayer,
    AgentConnectionType.Http,
  );

  const toKey = getCloudAgentKey(agentConfig, Role.Relayer);
  await toKey.fetch();

  const chainsForEnv = Object.keys(envConfig.chainMetadataConfigs).filter(
    (chain) => chainMetadata[chain].protocol == ProtocolType.Ethereum,
  );
  for (const originChain of chainsForEnv) {
    try {
      const fromKey = new OldRelayerAwsKey(agentConfig, originChain);
      await fromKey.fetch();
      for (const chain of chainsForEnv) {
        await transfer(chain, agentConfig, multiProvider, fromKey, toKey);
      }
      // await fromKey.delete();
      console.log('Deleted key', {
        from: fromKey.identifier,
        fromKey: fromKey.address,
      });
    } catch (err) {
      console.error('Error transferring funds', {
        ctx,
        env,
        originChain,
        err,
      });
    }
  }
}

async function transfer(
  chain: ChainName,
  agentConfig: AgentContextConfig,
  multiProvider: MultiProvider,
  fromKey: CloudAgentKey,
  toKey: CloudAgentKey,
) {
  if (chainMetadata[chain].protocol != ProtocolType.Ethereum) return;
  const logCtx: any = {
    chain,
    from: fromKey.identifier,
    fromKey: fromKey.address,
    to: toKey.identifier,
    toKey: toKey.address,
  };
  console.log('Processing key', logCtx);

  const transferTx: PopulatedTransaction = {
    to: toKey.address,
    value: BigNumber.from(0),
  };
  const [gasPrice, gasToTransfer, initialBalance] = await Promise.all([
    multiProvider.getProvider(chain).getGasPrice(),
    multiProvider.estimateGas(chain, transferTx),
    multiProvider.getProvider(chain).getBalance(fromKey.address),
  ]);
  const costToTransfer = gasToTransfer.mul(gasPrice);
  if (costToTransfer.gt(initialBalance)) {
    console.log('Not enough funds to transfer', {
      ...logCtx,
      balance: formatEther(initialBalance),
    });
    return;
  }
  transferTx.value = initialBalance.sub(costToTransfer);
  transferTx.gasLimit = gasToTransfer;
  transferTx.gasPrice = gasPrice;

  // await multiProvider.sendTransaction(chain, transferTx);
  const [finalBalance, finalDestBalance] = await Promise.all([
    multiProvider.getProvider(chain).getBalance(fromKey.address),
    multiProvider.getProvider(chain).getBalance(toKey.address),
  ]);
  console.log('Transferred funds', {
    ...logCtx,
    initialBalance: formatEther(initialBalance),
    finalBalance: formatEther(finalBalance),
    finalDestBalance: formatEther(finalDestBalance),
    transferred: formatEther(transferTx.value),
    cost: formatEther(costToTransfer),
    transferTx,
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
