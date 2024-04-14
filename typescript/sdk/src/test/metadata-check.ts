/* eslint-disable no-console */
import { ethers } from 'ethers';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata.js';
import { CoreChainName, TestChains } from '../consts/chains.js';
import { isBlockExplorerHealthy, isRpcHealthy } from '../metadata/health.js';
import { ChainMap } from '../types.js';

const PROTOCOL_TO_ADDRESS: Record<ProtocolType, Address> = {
  [ProtocolType.Ethereum]: ethers.constants.AddressZero,
  [ProtocolType.Sealevel]: '11111111111111111111111111111111',
  [ProtocolType.Cosmos]: 'cosmos100000000000000000000000000000000000000',
  [ProtocolType.Fuel]: '',
};

const PROTOCOL_TO_TX_HASH: Record<ProtocolType, Address> = {
  [ProtocolType.Ethereum]: ethers.constants.HashZero,
  [ProtocolType.Sealevel]:
    '1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
  [ProtocolType.Cosmos]:
    '0000000000000000000000000000000000000000000000000000000000000000',
  [ProtocolType.Fuel]: '',
};

async function main() {
  const results: ChainMap<{
    goodRpcs: number;
    badRpcs: number;
    goodExplorers: number;
    badExplorers: number;
  }> = {};
  const badList: string[] = [];

  for (const metadata of Object.values(chainMetadata)) {
    if (TestChains.includes(metadata.name as CoreChainName)) continue;

    console.log(`Checking metadata health for ${metadata.name}`);
    if (!metadata.rpcUrls) {
      console.error(`No rpcUrls for ${metadata.name}, invalid chain metadata`);
    }
    if (!metadata.blockExplorers?.length) {
      console.warn(
        `No block explorers for ${metadata.name}, consider adding one`,
      );
    }

    results[metadata.name] = {
      goodRpcs: 0,
      badRpcs: 0,
      goodExplorers: 0,
      badExplorers: 0,
    };

    for (const rpc of metadata.rpcUrls) {
      const isHealthy = await isRpcHealthy(
        rpc,
        metadata.chainId,
        metadata.protocol,
      );
      if (!isHealthy) {
        console.error(`RPC ${rpc.http} for ${metadata.name} is not healthy`);
        results[metadata.name].badRpcs += 1;
        badList.push(rpc.http);
      } else {
        results[metadata.name].goodRpcs += 1;
      }
    }

    if (!metadata.blockExplorers?.length) continue;
    // This only tests the first explorer since that's
    // what the related utils use anyway
    const firstExplorerUrl = metadata.blockExplorers[0].url;
    const isHealthy = await isBlockExplorerHealthy(
      metadata,
      PROTOCOL_TO_ADDRESS[metadata.protocol],
      PROTOCOL_TO_TX_HASH[metadata.protocol],
    );
    if (!isHealthy) {
      console.error(
        `Explorer ${firstExplorerUrl} for ${metadata.name} is not healthy`,
      );
      results[metadata.name].badExplorers += 1;
      badList.push(firstExplorerUrl);
    } else {
      results[metadata.name].goodExplorers += 1;
    }
  }

  console.table(results);
  console.log('The bad ones:\n===============');
  console.log(badList);

  if (badList.length) {
    console.error('Some RPCs or block explorers are unhealthy');
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Unhandled error running test:', err);
    process.exit(1);
  });
