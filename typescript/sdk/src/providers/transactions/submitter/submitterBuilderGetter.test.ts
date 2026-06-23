import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../../consts/testChains.js';
import { MultiProvider } from '../../MultiProvider.js';
import { randomAddress } from '../../../test/testUtils.js';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EV5JsonRpcTxSubmitter } from './ethersV5/EV5JsonRpcTxSubmitter.js';
import {
  type SubmitterFactory,
  getSubmitter,
} from './submitterBuilderGetter.js';

describe('getSubmitter additionalSubmitterFactories threading', () => {
  const chain = TestChainName.test1;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  it('keeps custom factories available when a nested resolution passes an empty factory map', async () => {
    let nestedOverrideCalls = 0;

    // GNOSIS_SAFE is overridden to act as a wrapping submitter that recursively
    // resolves a nested JSON_RPC submitter, deliberately forwarding an EMPTY
    // factory map (the exact case the `??` bug mishandled at depth >= 2).
    const overrides: Record<string, SubmitterFactory> = {
      [TxSubmitterType.GNOSIS_SAFE]: (
        mp,
        metadata,
        coreAddressesByChain,
        getSubmitterFn,
      ) =>
        getSubmitterFn(
          mp,
          { type: TxSubmitterType.JSON_RPC, chain: metadata.chain },
          coreAddressesByChain,
          {},
        ),
      [TxSubmitterType.JSON_RPC]: (mp, metadata) => {
        nestedOverrideCalls++;
        return new EV5JsonRpcTxSubmitter(mp, metadata);
      },
    };

    await getSubmitter(
      multiProvider,
      {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain,
        safeAddress: randomAddress(),
      },
      {},
      { [ProtocolType.Ethereum]: overrides },
    );

    // With the buggy `nestedFactories ?? additionalSubmitterFactories`, the empty
    // map would have shadowed the parent's overrides and the DEFAULT JSON_RPC
    // factory would have run instead, leaving this counter at 0.
    expect(nestedOverrideCalls).to.equal(1);
  });
});
