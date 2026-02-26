import { expect } from 'chai';
import { zeroAddress } from 'viem';

import { TestChainName, test1 } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import { MultiProtocolCore } from './MultiProtocolCore.js';
import { EvmCoreAdapter } from './adapters/EvmCoreAdapter.js';

describe('MultiProtocolCore', () => {
  it('constructs', () => {
    const multiProvider = new MultiProtocolProvider({
      test1: {
        ...test1,
      },
    });
    const core = new MultiProtocolCore(multiProvider, {
      test1: {
        validatorAnnounce: zeroAddress,
        proxyAdmin: zeroAddress,
        mailbox: zeroAddress,
      },
    });
    expect(core).to.be.instanceOf(MultiProtocolCore);
    const ethAdapter = core.adapter(TestChainName.test1);
    expect(ethAdapter).to.be.instanceOf(EvmCoreAdapter);
  });
});
