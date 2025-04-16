import Safe from '@safe-global/protocol-kit';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import { regularSafes } from '../../../config/environments/mainnet3/governance/safe/regular.js';
import { AnnotatedCallData } from '../../../src/govern/HyperlaneAppGovernor.js';
import { SafeMultiSend } from '../../../src/govern/multisend.js';
import { Role } from '../../../src/roles.js';
import { getSafeAndService, updateSafeOwner } from '../../../src/utils/safe.js';
import { getEnvironmentConfig } from '../../core-utils.js';

import { SIGNERS, THRESHOLD } from './config.js';

// test safes
// const regularSafes: ChainMap<Address> = {
//   abstract: '0x9ba626ff80C3D780345056c13AE4718cCf2a6C90',
// arbitrum: '0xe17d526C75E38E8aE5AE4FD7e92AEcD9deC689b6',
// base: '0xffd775571907dcf8d7364FF11a8737b231f3d21F',
// berachain: '0xF80710B197CA2cEf5f996cb48A51D7c076A91637',
// blast: '0x7fDFd78B278f88C1A1921B7AeC69aC509862C44f',
// bsc: '0xA39d4293D4f8DD5478f9c3d8401C04716292f6e5',
// ethereum: '0x23552b93414814ed866737d72eb5d00387c9cdDa',
// fraxtal: '0xefECAd428e47EfA03a693809eFFa794D29a11565',
// hyperevm: '0x1B44B93a1Aa46F722A65527fAEC24998B7646ea9',
// linea: '0xB1a6Bb737bdb9997ba771B50fAd7aAc1A0F5b361',
// mantapacific: '0xFA835fACD0EDE8D704De880E609c7818B7769173',
// mode: '0xF80710B197CA2cEf5f996cb48A51D7c076A91637',
// optimism: '0xAAFFF5Fd62262FA1Cc5f7585f385C41963487934',
// sei: '0xA3C145C50242aAebFB54f822cE1E747B7fED76af',
// sophon: '0xc5Bd512C8cf3cbd76060a2725972C96416d4CfCA',
// swell: '0xA3C145C50242aAebFB54f822cE1E747B7fED76af',
// taiko: '0x7925c7cEf6539655eF564b1DBA935F91649E66f8',
// treasure: '0x06385C0C7f44017e54eC06f7A25D7D054b99C47D',
// zeronetwork: '0x7D4dD5576E6ad5f98c1e32290728E8190D7b0873',
// zksync: '0x38290AF9Ee787d9f4B243c11d32eD8d3bB5D9A43',
// zklink: '0x7D4dD5576E6ad5f98c1e32290728E8190D7b0873',
// zircuit: '0x1B44B93a1Aa46F722A65527fAEC24998B7646ea9',
// };

// test safe links
// const testSafeLinks: ChainMap<string> = {
//   abstract:
//     'https://abstract-safe.protofire.io/home?safe=abstract:0x9ba626ff80C3D780345056c13AE4718cCf2a6C90',
//   arbitrum:
//     'https://app.safe.global/home?safe=arb1:0xe17d526C75E38E8aE5AE4FD7e92AEcD9deC689b6',
//   base: 'https://app.safe.global/home?chain=base&safe=base:0xffd775571907dcf8d7364FF11a8737b231f3d21F',
//   berachain:
//     'https://safe.berachain.com/home?safe=berachain:0xF80710B197CA2cEf5f996cb48A51D7c076A91637',
//   blast:
//     'https://app.safe.global/home?safe=blast:0x7fDFd78B278f88C1A1921B7AeC69aC509862C44f',
//   bsc: 'https://app.safe.global/home?safe=bnb:0xA39d4293D4f8DD5478f9c3d8401C04716292f6e5',
//   ethereum:
//     'https://app.safe.global/home?safe=eth:0x23552b93414814ed866737d72eb5d00387c9cdDa',
//   fraxtal:
//     'https://safe.mainnet.frax.com/transactions/queue?safe=fraxtal:0xefECAd428e47EfA03a693809eFFa794D29a11565',
//   hyperevm:
//     'https://wl-hyperliquid-palmera-dao.vercel.app/home?safe=hype:0x1B44B93a1Aa46F722A65527fAEC24998B7646ea9',
//   linea:
//     'https://app.safe.global/home?safe=linea:0xB1a6Bb737bdb9997ba771B50fAd7aAc1A0F5b361',
//   mantapacific:
//     'https://safe.manta.network/transactions/queue?safe=manta:0xFA835fACD0EDE8D704De880E609c7818B7769173',
//   mode: 'https://safe.optimism.io/home?safe=mode:0xF80710B197CA2cEf5f996cb48A51D7c076A91637',
//   optimism:
//     'https://app.safe.global/home?safe=oeth:0xAAFFF5Fd62262FA1Cc5f7585f385C41963487934',
//   sei: 'https://sei-safe.protofire.io/home?safe=sei:0xA3C145C50242aAebFB54f822cE1E747B7fED76af',
//   sophon:
//     'https://safe.sophon.xyz/home?safe=sophon:0xc5Bd512C8cf3cbd76060a2725972C96416d4CfCA',
//   swell:
//     'https://safe.optimism.io/home?safe=swell-l2:0xA3C145C50242aAebFB54f822cE1E747B7fED76af',
//   taiko:
//     'https://safe.taiko.xyz/home?safe=taiko:0x7925c7cEf6539655eF564b1DBA935F91649E66f8',
//   treasure:
//     'https://app.palmeradao.xyz/6751ed2cf70aa4d63124285f/details?safe=treasure%3A0x06385C0C7f44017e54eC06f7A25D7D054b99C47D',
//   zeronetwork:
//     'https://safe-whitelabel-git-zero-palmera-dao.vercel.app/settings/setup?safe=ZERϴ:0x7D4dD5576E6ad5f98c1e32290728E8190D7b0873',
//   zircuit:
//     'https://safe.zircuit.com/home?safe=zircuit:0x1B44B93a1Aa46F722A65527fAEC24998B7646ea9',
//   zklink:
//     'https://safe.zklink.io/home?safe=zklink-nova:0x7D4dD5576E6ad5f98c1e32290728E8190D7b0873',
//   zksync:
//     'https://app.safe.global/home?safe=zksync:0x38290AF9Ee787d9f4B243c11d32eD8d3bB5D9A43',
// };

async function main() {
  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    Object.keys(regularSafes),
  );

  for (const [chain, safeAddress] of Object.entries(regularSafes)) {
    let safeSdk: Safe.default;
    try {
      ({ safeSdk } = await getSafeAndService(
        chain,
        multiProvider,
        safeAddress,
      ));
    } catch (error) {
      rootLogger.error(`[${chain}] could not get safe: ${error}`);
      continue;
    }

    let safeMultiSend: SafeMultiSend;
    try {
      safeMultiSend = new SafeMultiSend(
        multiProvider,
        chain as ChainName,
        safeAddress,
      );
    } catch (error) {
      rootLogger.error(`[${chain}] could not get safe multi send: ${error}`);
      continue;
    }

    let transactions: AnnotatedCallData[];
    try {
      transactions = await updateSafeOwner(safeSdk, SIGNERS, THRESHOLD);
    } catch (error) {
      rootLogger.error(`[${chain}] could not update safe owner: ${error}`);
      continue;
    }

    rootLogger.info(`[${chain}] Generated transactions for updating signers`);
    rootLogger.info(`[${chain}] ${JSON.stringify(transactions, null, 2)}`);

    try {
      await safeMultiSend.sendTransactions(
        transactions.map((call) => ({
          to: call.to,
          data: call.data,
          value: call.value,
        })),
      );
      rootLogger.info(`[${chain}] Successfully sent transactions`);
    } catch (error) {
      rootLogger.error(`[${chain}] could not send transactions: ${error}`);
    }
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
