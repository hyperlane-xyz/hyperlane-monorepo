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

const ENVIRONMENTS: DeployEnvironment[] = ['testnet3', 'mainnet2'];

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

  // const envConfig = getEnvironmentConfig('mainnet2');
  // const agentConfig = getAgentConfig(Contexts.Hyperlane, envConfig);
  // const from = new OldRelayerAwsKey(agentConfig, Chains.bsc);
  // const to = getCloudAgentKey(agentConfig, Role.Deployer);
  // const provider = await fetchProvider('mainnet2', Chains.optimism);
  //
  // await Promise.all([from.fetch(), to.fetch()]);
  // await transfer(Chains.optimism, agentConfig, provider, from, to);
}

async function transferForEnv(ctx: Contexts, env: DeployEnvironment) {
  const envConfig = getEnvironmentConfig(env);
  const agentConfig = getAgentConfig(ctx, envConfig);

  // always transfer to the main hyperlane context
  const toKey = getCloudAgentKey(
    getAgentConfig(Contexts.Hyperlane, envConfig),
    Role.Deployer,
  );
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
    let errorOccurred = false;
    const fromKey = new OldRelayerAwsKey(agentConfig, relayerOriginChain);
    await fromKey.fetch();
    // start all the promises and then wait for them to finish
    const promises = [].map((chain) =>
      transfer(chain, agentConfig, providers[chain], fromKey, toKey),
    );
    for (const p of promises) {
      try {
        await p;
      } catch (err) {
        errorOccurred = true;
        console.error('Error transferring funds', {
          ctx,
          env,
          relayerOriginChain,
          err,
        });
      }
    }
    if (!errorOccurred) {
      await fromKey.disable();
      console.log('Disabled key', {
        from: fromKey.identifier,
        fromKey: fromKey.address,
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

  console.debug('Estimating gas', logCtx);
  const gasToTransfer = await provider.estimateGas(transferTx);

  console.debug('Getting gas price', logCtx);
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

  if (chain == Chains.optimism) {
    // I give up, the correct way to do this is make a contract call against the gas oracle with an
    // RLP encoded version of the txn, but this is probably close enough to work most of the time.
    costToTransfer = costToTransfer.add(BigNumber.from(4e-5 * 1e18));
  } else if (L2Chains.includes(chain)) {
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

  // transferTx.value = BigNumber.from(1);
  transferTx.value = initialBalance.sub(costToTransfer);
  transferTx.gasLimit = gasToTransfer;

  console.debug('Sending transaction', {
    ...logCtx,
    initialBalance: formatEther(initialBalance),
    transferring: formatEther(transferTx.value),
    cost: formatEther(costToTransfer),
    gas: gasToTransfer.toNumber(),
    gasPrice: formatEther(feeData.gasPrice ?? 0),
    maxFeePerGas: formatEther(feeData.maxFeePerGas ?? 0),
    maxPriorityFeePerGas: formatEther(feeData.maxPriorityFeePerGas ?? 0),
    transferTx,
  });
  const response = await signer.sendTransaction(transferTx);
  console.log('Transfer sent', {
    ...logCtx,
    response,
  });

  let receipt;
  do {
    console.debug('Waiting for receipt', logCtx);
    try {
      const r = await provider.waitForTransaction(response.hash, 3, 60 * 1000);
      if (r) receipt = r;
    } catch (err) {
      console.error('Error getting receipt', { ...logCtx, err });
    }
  } while (!receipt);

  if (!receipt.status) {
    throw Error('Transfer failed: ' + JSON.stringify({ ...logCtx, receipt }));
  } else {
    console.log('Transferred funds', {
      ...logCtx,
      receipt,
    });
  }
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
