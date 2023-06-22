import { TransactionRequest } from '@ethersproject/abstract-provider/src.ts';
import { Provider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { formatEther } from 'ethers/lib/utils';

import {
  ChainMap,
  ChainName,
  Chains,
  ProtocolType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts';
import { AgentAwsKey } from '../src/agents/aws';
import { getCloudAgentKey } from '../src/agents/key-utils';
import { CloudAgentKey } from '../src/agents/keys';
import { AgentContextConfig, DeployEnvironment } from '../src/config';
import { fetchProvider } from '../src/config/chain';
import { Role } from '../src/roles';

import { getAgentConfig, getEnvironmentConfig } from './utils';

// const ENVIRONMENTS: DeployEnvironment[] = ['mainnet2', 'testnet3'];
const ENVIRONMENTS: DeployEnvironment[] = ['testnet3'];

const L2Chains: ChainName[] = [
  Chains.optimism,
  Chains.optimismgoerli,
  Chains.arbitrum,
  Chains.arbitrumgoerli,
];

async function main() {
  for (const ctx of Object.values(Contexts)) {
    for (const env of ENVIRONMENTS) {
      await transferForEnv(ctx, env);
    }
  }

  // const envConfig = getEnvironmentConfig('testnet3');
  // const agentConfig = getAgentConfig(Contexts.Hyperlane, envConfig);
  // const from = new OldRelayerAwsKey(agentConfig, Chains.fuji);
  // const to = getCloudAgentKey(agentConfig, Role.Relayer);
  // const provider = await fetchProvider('testnet3', Chains.optimismgoerli);
  //
  // await Promise.all([from.fetch(), to.fetch()]);
  // await transfer(Chains.optimismgoerli, agentConfig, provider, from, to);
}

async function transferForEnv(ctx: Contexts, env: DeployEnvironment) {
  const envConfig = getEnvironmentConfig(env);
  const agentConfig = getAgentConfig(ctx, envConfig);

  const toKey = getCloudAgentKey(agentConfig, Role.Relayer);
  await toKey.fetch();

  const chainsForEnv = Object.keys(envConfig.chainMetadataConfigs).filter(
    (chain) => chainMetadata[chain].protocol == ProtocolType.Ethereum,
  );
  const providers: ChainMap<Provider> = Object.fromEntries(
    await Promise.all(
      chainsForEnv.map(async (chain) => [
        chain,
        await fetchProvider(env, chain),
      ]),
    ),
  );

  for (const relayerOriginChain of chainsForEnv) {
    try {
      const fromKey = new OldRelayerAwsKey(agentConfig, relayerOriginChain);
      await fromKey.fetch();
      for (const chain of chainsForEnv) {
        await transfer(chain, agentConfig, providers[chain], fromKey, toKey);
      }
      // await fromKey.delete();
      // console.log('Deleted key', {
      //   from: fromKey.identifier,
      //   fromKey: fromKey.address,
      // });
    } catch (err) {
      console.error('Error transferring funds', {
        ctx,
        env,
        relayerOriginChain,
        err,
      });
    }
  }
}

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
  const [initialBalance, feeData] = await Promise.all([
    provider.getBalance(fromKey.address),
    provider.getFeeData(),
  ]);

  // Polygon needs a max priority fee >= 30 gwei
  if (
    feeData.maxPriorityFeePerGas &&
    feeData.maxFeePerGas &&
    (chain == Chains.polygon || chain == Chains.mumbai)
  ) {
    const actual = feeData.maxPriorityFeePerGas ?? BigNumber.from(0);
    const min = BigNumber.from(30e9);
    if (actual.lt(min)) {
      feeData.maxPriorityFeePerGas = min;
      feeData.maxFeePerGas = feeData.maxFeePerGas.add(min.sub(actual));
    }
  }

  let costToTransfer;
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    costToTransfer = feeData.maxFeePerGas.mul(gasToTransfer);
    transferTx.maxFeePerGas = feeData.maxFeePerGas;
    transferTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    const gasPrice = feeData.gasPrice ?? (await provider.getGasPrice());
    costToTransfer = gasToTransfer.mul(gasPrice);
    transferTx.gasPrice = gasPrice;
  }

  if (L2Chains.includes(chain)) {
    // 25% extra for l1 security fees
    costToTransfer = costToTransfer.mul(5).div(4);
  }

  if (costToTransfer.gt(initialBalance)) {
    console.log('Not enough funds to transfer', {
      ...logCtx,
      balance: formatEther(initialBalance),
    });
    return;
  }

  transferTx.value = initialBalance.sub(costToTransfer);
  transferTx.gasLimit = gasToTransfer;

  console.debug('Sending transaction', {
    ...logCtx,
    initialBalance: formatEther(initialBalance),
    transferring: formatEther(transferTx.value),
    cost: formatEther(costToTransfer),
    gas: formatEther(gasToTransfer),
    gasPrice: formatEther(feeData.gasPrice ?? 0),
    maxFeePerGas: formatEther(feeData.maxFeePerGas ?? 0),
    maxPriorityFeePerGas: formatEther(feeData.maxPriorityFeePerGas ?? 0),
    transferTx,
  });
  const receipt = await signer.sendTransaction(transferTx);

  console.log('Transferred funds', {
    ...logCtx,
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
