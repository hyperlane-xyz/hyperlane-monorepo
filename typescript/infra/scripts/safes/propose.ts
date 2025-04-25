import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbiItem,
} from 'viem';
import { mainnet } from 'viem/chains';
import yargs from 'yargs';

import { assert } from '@hyperlane-xyz/utils';

import { awSafes as safes } from '../../config/environments/mainnet3/governance/safe/aw.js';
import {
  NETWORK,
  SUBNETWORK_IDENTIFIER,
} from '../../config/environments/mainnet3/symbiotic.js';
import { PRODUCTION } from '../../config/environments/mainnet3/warp/configGetters/getHyperWarpConfig.js';
import { SafeMultiSend } from '../../src/govern/multisend.js';
import { withChain } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const VAULTS = [
  {
    name: 'stHYPER',
    vault: '0xE1F23869776c82f691d9Cb34597Ab1830Fb0De58',
  },
];

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

const SCHEDULE = true;
const EXECUTE = false;

const LIMITS = {
  ETH: BigInt(3000e18),
  BTC: BigInt(100e8),
  // set max limit for HYPER
  HYPER: BigInt(PRODUCTION.INITIAL_SUPPLY),
};

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
    let asset: keyof typeof LIMITS;
    if (name.endsWith('ETH')) {
      asset = 'ETH';
    } else if (name.endsWith('BTC')) {
      asset = 'BTC';
    } else if (name.endsWith('HYPER')) {
      asset = 'HYPER';
    } else {
      throw new Error(`Invalid vault name ${name}`);
    }

    const limit = LIMITS[asset];

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

  const calls = delegatorLimitCalls;
  const provider = multiProvider.getProvider(chain);
  for (const call of calls) {
    // simulate
    await provider.estimateGas({
      from: NETWORK,
      to: call.to,
      data: call.data,
    });
  }

  const targets = calls.map(({ to }) => to);
  assert(new Set(targets).size === targets.length, 'Duplicate targets');

  const payloads = calls.map(({ data }) => data);
  const values = calls.map(() => BigInt(0));

  const description = calls.map(({ description }) => description).join('\n');

  if (SCHEDULE) {
    const scheduleTx = {
      to: NETWORK,
      data: encodeFunctionData({
        abi: [SCHEDULE_BATCH_ABI],
        args: [
          targets,
          values,
          payloads,
          ZERO_BYTES32,
          ZERO_BYTES32,
          BigInt(0),
        ],
      }),
      description: `Schedule batch:\n ${description}`,
    };

    console.log(scheduleTx);
    await multisend.sendTransactions([scheduleTx]);
  }

  if (EXECUTE) {
    const executeTx = {
      to: NETWORK,
      data: encodeFunctionData({
        abi: [EXECUTE_BATCH_ABI],
        args: [targets, values, payloads, ZERO_BYTES32, ZERO_BYTES32],
      }),
      description: `Execute batch:\n ${description}`,
    };

    console.log(executeTx);
    await multiProvider.sendTransaction(chain, executeTx);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
