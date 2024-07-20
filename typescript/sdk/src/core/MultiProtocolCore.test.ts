import { expect } from 'chai';
import { ethers } from 'ethers';

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
        validatorAnnounce: ethers.constants.AddressZero,
        proxyAdmin: ethers.constants.AddressZero,
        mailbox: ethers.constants.AddressZero,
      },
    });
    expect(core).to.be.instanceOf(MultiProtocolCore);
    const ethAdapter = core.adapter(TestChainName.test1);
    expect(ethAdapter).to.be.instanceOf(EvmCoreAdapter);
  });
});
