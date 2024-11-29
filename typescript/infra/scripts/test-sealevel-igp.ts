import { PublicKey } from '@solana/web3.js';

import {
  SealevelHypNativeAdapter,
  SealevelOverheadIgpAdapter,
} from '@hyperlane-xyz/sdk';

import { getConfigsBasedOnArgs } from './core-utils.js';

async function main() {
  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();

  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();
  // const igp = new SealevelOverheadIgpAdapter(
  //   'eclipsemainnet',
  //   multiProtocolProvider,
  //   {
  //     overheadIgp: '3Wp4qKkgf4tjXz1soGyTSndCgBPLZFSrZkiDZ8Qp9EEj',
  //     programId: 'Hs7KVBU67nBnWhDPZkEFwWqrFMUfJbmY2DQ4gmCZfaZp',
  //   },
  // );

  const token = new SealevelHypNativeAdapter(
    'eclipsemainnet',
    multiProtocolProvider,
    {
      // apxETH
      // warpRouter: '9pEgj7m2VkwLtJHPtTw5d8vbB7kfjzcXXCRgdwruW7C2',
      warpRouter: 'EqRSt9aUDMKYKhzd1DGMderr3KNp29VZH3x5P7LFTC8m',
      mailbox: 'EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y',
    },
  );

  // const destDomain = multiProtocolProvider.getDomainId('solanamainnet');
  const quote = await token.quoteTransferRemoteGas(
    1,
    'G5FM3UKwcBJ47PwLWLLY1RQpqNtTMgnqnd6nZGcJqaBp',
    // BigInt(100000),
    // new PublicKey('EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y'),
  );
  console.log('quote', quote, quote.toString());
}

main().catch(console.error);
