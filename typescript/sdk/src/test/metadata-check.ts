/* eslint-disable no-console */
import { ethers } from 'ethers';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { Chains, CoreChainName, TestChains } from '../consts/chains';
import { isBlockExplorerHealthy, isRpcHealthy } from '../metadata/health';
import { ChainMap } from '../types';

const PROTOCOL_TO_ADDRESS: Record<ProtocolType, Address> = {
  [ProtocolType.Ethereum]: ethers.constants.AddressZero,
  [ProtocolType.Sealevel]: '00000000000000000000000000000000000000000000',
  [ProtocolType.Cosmos]: 'cosmos100000000000000000000000000000000000000',
  [ProtocolType.Fuel]: '',
};

// A random tx hash for each chain, used to test explorer link
const CHAIN_TO_TX_HASH: Record<string, string> = {
  [Chains.alfajores]:
    '0xf566f1ba4af5ac53081dc4b22fcac29fe5e9a25f5e134ca5464231ed7d2ffc81',
  [Chains.arbitrum]:
    '0x30093a67a823ca6b024eb5ca6f7d5cf7e967557662155e783827efcfeb29690f',
  [Chains.arbitrumgoerli]:
    '0xa86668384160a1b580bdbeabfce212524663143e94b68eb1e7fc48f20bbedc8c',
  [Chains.avalanche]:
    '0x244ae94a424906c88b2f7fc7697ce78f26fbfc74bee5040d63e1a1c6ef9eb84b',
  [Chains.base]:
    '0x27c0d75d1a38c0a31b0f41fd20d28a62be4ac83999abdf4f6ea607379b3f3d0d',
  [Chains.basegoerli]:
    '0xea6274abba0ad633d0155fc6cb5d25edb24bb7005c7b4aed33390716cf773c32',
  [Chains.bsc]:
    '0x18bd183cd2dc56a462b27331b8d28cddabde0c556698da29d69ee04c1b8b2c9c',
  [Chains.bsctestnet]:
    '0xcfa8f9c0b601913ddf0f99e03e0e2c211ef59bde7eba72eb8f7df739f913466f',
  [Chains.celo]:
    '0xb217245342d224c96876849bc2964cac6c648b7b054fd0b0278c5e98e540843b',
  [Chains.chiado]:
    '0x29d0828c8d1852097736220dd439716ec342caceb41d9edf4be9fda598c837df',
  [Chains.ethereum]:
    '0xf2f0373bdbdff84640b6d7f37ea999746715df499190b7a1095266066d1b7356',
  [Chains.fuji]:
    '0xb1b93727cea040b3164056d0b97785e8f0e4b7a749b0a56f9d1c2cf37bec0455',
  [Chains.gnosis]:
    '0x9f6d46b6be0adbcf6fa4517c6897a11763d4a5aa5e31e6b6b66a0463de958c25',
  [Chains.goerli]:
    '0xf9eeb8068f02d086fe100bc420af57384eff0fdc4f88e68e4e17e1985a7e2bf0',
  [Chains.lineagoerli]:
    '0xe0fad79e60d6178452bc07cf15c07cdda97deccd2b197af7790e978a8e5835ac',
  [Chains.mantapacific]:
    '0x045adb06cae25de2c90be0a8610f7adc226c34d0b03d4383ce3cb2157561d656',
  [Chains.moonbasealpha]:
    '0xe6711bc12bc1cef88f29e3bbabd9fbb050cfca086a5449f7d4da3819bdc77859',
  [Chains.moonbeam]:
    '0xf387fa67cf7f4a33d30c0c53900d21c4eff7867f5457a8b9f54802087a07eb96',
  [Chains.mumbai]:
    '0xeff94a58c83814e3c0fbaa721e95cd76f2dd00274ab547ed2e7d9a78b029c62a',
  [Chains.nautilus]: '',
  [Chains.neutron]:
    '4663DAD97C53850A2BAE898514971BACC8EB8B3C1FE9DBA3E62F5AC86D600E73',
  [Chains.optimism]:
    '0x139b9beec241a1258630367a2ec0c6567bfd5ce23cfc0c189fbd26b5eb657a33',
  [Chains.optimismgoerli]:
    '0xd84ae2271533f83c2adea10bd1bebcb97a9bad70ccfb7d771b4159ab0cadfda3',
  [Chains.polygon]:
    '0x7cf70156dbf12005875f73f48e903e40914d9a69a9487f0834e2d79132ec22f3',
  [Chains.polygonzkevm]:
    '0xf3fd1213a7b8db63031e83de929169896cbfae33004bb7a55234a1f72cb53d5f',
  [Chains.polygonzkevmtestnet]:
    '0xf758cfe7f83c9556300f687b01e0f9fcb15156f70406cb54122a0531394ce496',
  [Chains.proteustestnet]: '',
  [Chains.scroll]:
    '0x262a4c4ee74f1a81ed414ffad3a8e2046ad2521252b2091f1acb053239aab5b7',
  [Chains.scrollsepolia]:
    '0xe2093b1a4c6a0d9d34e6441b449e7cb4e7a785a41e5df2df9a981968888813ae',
  [Chains.sepolia]:
    '0xdacc9d206b55ba553afc42e2c207e355aacaf96855845b3a746f294fefd4f39d',
  [Chains.solana]:
    '23346vC32nGAaq4ADj8zJqzVv9DGcY6oqnEbM7g1d1Ydqh8wziEgavKXx1qNqqqHMwKq3LRqaGwMMH7wK9UhAuz4',
  [Chains.solanadevnet]:
    '58XxWq2AD5Hw58cJxbhLNXsbycHUmHhkUpdacZWBTTz5kFW4dstTHVcb8MKJMRxiG4eVsnmb3Qhbf3TVriuCad4n',
  [Chains.test1]: '',
  [Chains.test2]: '',
  [Chains.test3]: '',
};

// Note: run with DEBUG=hyperlane for more detailed logs
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
      CHAIN_TO_TX_HASH[metadata.name],
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
