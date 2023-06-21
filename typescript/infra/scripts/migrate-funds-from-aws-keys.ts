import { BigNumber, PopulatedTransaction } from 'ethers';
import { formatEther } from 'ethers/lib/utils';

import {
  AgentConnectionType,
  ChainName,
  HyperlaneIgp,
  MultiProvider,
  ProtocolType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts';
import { AgentAwsKey } from '../src/agents/aws';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import { AgentContextConfig } from '../src/config';
import {
  DeployEnvironment,
  deployEnvToSdkEnv,
} from '../src/config/environment';
import { Role } from '../src/roles';

import { getAgentConfig, getEnvironmentConfig } from './utils';

const ENVIRONMENTS: DeployEnvironment[] = ['mainnet2', 'testnet3'];

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
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[env],
    multiProvider,
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
        await transfer(chain, agentConfig, igp, multiProvider, fromKey, toKey);
      }
      await fromKey.delete();
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
  igp: HyperlaneIgp,
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

  const igpContract = igp.getContracts(chain).interchainGasPaymaster;

  const igpBalance = await multiProvider
    .getProvider(chain)
    .getBalance(igpContract.address);
  const claimIgpFundsTx = await igpContract.populateTransaction.claim();
  const gasToClaimIgpFunds = await multiProvider.estimateGas(
    chain,
    claimIgpFundsTx,
  );
  let gasPrice = await multiProvider.getProvider(chain).getGasPrice();
  const costToClaimIgpFunds = gasPrice.mul(gasToClaimIgpFunds);
  if (igpBalance.gt(costToClaimIgpFunds)) {
    // only claim if the cost to do so is less than the balance we are claiming
    // await multiProvider.sendTransaction(chain, claimIgpFundsTx);
    console.log('Claimed IGP funds', {
      ...logCtx,
      igpAddress: igpContract.address,
      igpBalance: formatEther(igpBalance),
      cost: formatEther(costToClaimIgpFunds),
      tx: claimIgpFundsTx,
    });
    // update gas price since we might have waited a while
    gasPrice = await multiProvider.getProvider(chain).getGasPrice();
  } else {
    console.log('IGP balance too low to claim', {
      ...logCtx,
      igpAddress: igpContract.address,
      igpBalance: formatEther(igpBalance),
      cost: formatEther(costToClaimIgpFunds),
    });
  }

  const currentBalance = await multiProvider
    .getProvider(chain)
    .getBalance(fromKey.address);
  const transferTx: PopulatedTransaction = {
    to: toKey.address,
    value: BigNumber.from(0),
  };
  const gasToTransfer = await multiProvider.estimateGas(chain, transferTx);
  const costToTransfer = gasToTransfer.mul(gasPrice);
  if (costToTransfer.gt(currentBalance)) {
    console.log('Not enough funds to transfer', {
      ...logCtx,
      balance: formatEther(currentBalance),
    });
    return;
  }
  transferTx.value = currentBalance.sub(costToTransfer);
  transferTx.gasLimit = gasToTransfer;
  // await multiProvider.sendTransaction(chain, transferTx);
  console.log('Transferred funds', {
    ...logCtx,
    originalBalance: formatEther(currentBalance),
    finalBalance: formatEther(
      await multiProvider.getProvider(chain).getBalance(fromKey.address),
    ),
    destinationBalance: formatEther(
      await multiProvider.getProvider(chain).getBalance(toKey.address),
    ),
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
