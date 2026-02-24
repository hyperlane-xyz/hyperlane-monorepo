import { expect } from 'chai';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import {
  ChainTechnicalStack,
  MultiProtocolProvider,
  MultiProvider,
  test1,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ensureEvmSignersForChains } from '../../context/context.js';
import { type SignerKeyProtocolMap } from '../../context/types.js';
import { ANVIL_KEY } from '../ethereum/consts.js';

describe('ensureEvmSignersForChains', () => {
  it('uses ZkSync wallet for ZkSync chains', async () => {
    const chainMetadata = {
      test1: {
        ...test1,
        technicalStack: ChainTechnicalStack.ZkSync,
      },
    };

    const multiProvider = new MultiProvider(chainMetadata);
    const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
    const keyMap: SignerKeyProtocolMap = {
      [ProtocolType.Ethereum]: ANVIL_KEY,
    };

    await ensureEvmSignersForChains(
      { key: keyMap, multiProvider, multiProtocolProvider },
      ['test1'],
    );

    const signer = multiProvider.getSigner('test1');
    expect(signer).to.be.instanceOf(ZKSyncWallet);
  });
});
