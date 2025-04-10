import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbiItem,
} from 'viem';
import { mainnet } from 'viem/chains';
import yargs from 'yargs';

import { assert } from '@hyperlane-xyz/utils';

import { safes } from '../../config/environments/mainnet3/owners.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { withChain } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const VAULTS = [
  {
    name: 'EtherFi LBTC',
    vault: '0xd4E20ECA1f996Dab35883dC0AD5E3428AF888D45',
  },
  {
    name: 'EtherFi wstETH',
    vault: '0x450a90fdEa8B87a6448Ca1C87c88Ff65676aC45b',
  },
  {
    name: 'Renzo pzETH',
    vault: '0xa88e91cEF50b792f9449e2D4C699b6B3CcE1D19F',
  },
  {
    name: 'Swell swETH',
    vault: '0x65b560d887c010c4993c8f8b36e595c171d69d63',
  },
  {
    name: 'Swell WBTC',
    vault: '0x9e405601B645d3484baeEcf17bBF7aD87680f6e8',
  },
  {
    name: 'MEV Mellow wstETH',
    vault: '0x446970400e1787814CA050A4b45AE9d21B3f7EA7',
  },
  {
    name: 'MEV Symbiotic wstETH',
    vault: '0x4e0554959A631B3D3938ffC158e0a7b2124aF9c5',
  },
  {
    name: 'Gauntlet wstETH',
    vault: '0xc10A7f0AC6E3944F4860eE97a937C51572e3a1Da',
  },
  {
    name: 'Gauntlet cbETH',
    vault: '0xB8Fd82169a574eB97251bF43e443310D33FF056C',
  },
  {
    name: 'Gauntlet rETH',
    vault: '0xaF07131C497E06361dc2F75de63dc1d3e113f7cb',
  },
  {
    name: 'Gauntlet wBETH',
    vault: '0x81bb35c4152B605574BAbD320f8EABE2871CE8C6',
  },
  {
    name: 'P2P wstETH',
    vault: '0x7b276aAD6D2ebfD7e270C5a2697ac79182D9550E',
  },
  {
    name: 'Re7 wstETH',
    vault: '0x3D93b33f5E5fe74D54676720e70EA35210cdD46E',
  },
];

const NETWORK = '0x59cf937Ea9FA9D7398223E3aA33d92F7f5f986A2';

const SUBNETWORK_IDENTIFIER = BigInt(0);

const SET_LIMIT_ABI = parseAbiItem(
  'function setMaxNetworkLimit(uint96 identifier, uint256 amount)',
);

const VAULT_DELEGATOR_ABI = parseAbiItem(
  'function delegator() returns (address)',
);

const SCHEDULE_BATCH_ABI = parseAbiItem(
  'function scheduleBatch(address[] calldata targets,uint256[] calldata values,bytes[] calldata payloads,bytes32 predecessor,bytes32 salt,uint256 delay)',
);

const EXECUTE_BATCH_ABI = parseAbiItem(
  'function executeBatch(address[] calldata targets,uint256[] calldata values,bytes[] calldata payloads,bytes32 predecessor,bytes32 salt)',
);

const ZERO_BYTES32 = '0x'.padEnd(64 + 2, '0') as `0x${string}`;

async function main() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  const delegatorContracts = VAULTS.map(({ vault }) => ({
    address: vault as `0x${string}`,
    abi: [VAULT_DELEGATOR_ABI],
    functionName: 'delegator',
  }));

  const delegatorResults = await client.multicall({
    contracts: delegatorContracts,
  });

  const delegators = delegatorResults.map(({ status, result }) => {
    assert(status === 'success', 'Multicall failed');
    return result;
  });

  const { chain } = await withChain(yargs(process.argv.slice(2))).demandOption(
    'chain',
  ).argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider();

  const multisend = new SafeMultiSend(multiProvider, chain, safes[chain]);

  const delegatorLimitCalls = VAULTS.map(({ name, vault }, index) => {
    let asset: 'ETH' | 'BTC';
    if (name.endsWith('ETH')) {
      asset = 'ETH';
    } else if (name.endsWith('BTC')) {
      asset = 'BTC';
    } else {
      throw new Error(`Invalid vault name ${name}`);
    }

    const limit = asset === 'ETH' ? BigInt(3000e18) : BigInt(100e8);

    const delegator = delegators[index];

    return {
      to: delegator,
      data: encodeFunctionData({
        abi: [SET_LIMIT_ABI],
        args: [SUBNETWORK_IDENTIFIER, limit],
      }),
      description: `Set ${name} Hyperlane network delegation limit to ${limit} ${asset}`,
    };
  });

  const provider = multiProvider.getProvider(chain);
  for (const call of delegatorLimitCalls) {
    // simulate
    await provider.estimateGas({
      from: NETWORK,
      to: call.to,
      data: call.data,
    });
  }

  const targets = delegatorLimitCalls.map(({ to }) => to);
  assert(new Set(targets).size === targets.length, 'Duplicate targets');

  const payloads = delegatorLimitCalls.map(({ data }) => data);
  const values = delegatorLimitCalls.map(() => BigInt(0));

  const description = delegatorLimitCalls
    .map(({ description }) => description)
    .join('\n');

  const scheduleTx = {
    to: NETWORK,
    data: encodeFunctionData({
      abi: [SCHEDULE_BATCH_ABI],
      args: [targets, values, payloads, ZERO_BYTES32, ZERO_BYTES32, BigInt(0)],
    }),
    description: `Schedule batch:\n ${description}`,
  };

  console.log(scheduleTx);

  const executeTx = {
    to: NETWORK,
    data: encodeFunctionData({
      abi: [EXECUTE_BATCH_ABI],
      args: [targets, values, payloads, ZERO_BYTES32, ZERO_BYTES32],
    }),
    // description: `Execute batch:\n ${description}`,
  };

  console.log(executeTx);

  await multiProvider.sendTransaction(chain, executeTx);
  return;
  await multisend.sendTransactions([scheduleTx]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
