import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';

import { SigningHyperlaneModuleClient } from '../index.js';

// These private keys are public and contain funds on the Hyperlane Cosmos Simapp chain
// which are only used for testing and contain no real funds.
//
// DO NOT USE THOSE KEYS IN PRODUCTION
const PKS = {
  alice: '33913dd43a5d5764f7a23da212a8664fc4f5eedc68db35f3eb4a5c4f046b5b51',
  bob: '0afcf195989ebb6306f23271e50832332180b73055eb57f6d3c53263127e7d78',
  charlie: '8ef41fc20bf963ce18494c0f13e9303f70abc4c1d1ecfdb0a329d7fd468865b8',
};

export const createSigner = async (account: 'alice' | 'bob' | 'charlie') => {
  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(PKS[account], 'hex'),
    'hyp',
  );

  return SigningHyperlaneModuleClient.connectWithSigner(
    'http://127.0.0.1:26657',
    wallet,
    {
      gasPrice: GasPrice.fromString('0.2uhyp'),
    },
  );
};
