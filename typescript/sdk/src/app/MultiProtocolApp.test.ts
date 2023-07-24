import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { BaseEvmAdapter, MultiProtocolApp } from './MultiProtocolApp';

class TestMultiProtocolApp extends MultiProtocolApp {
  public override readonly adapters = {
    [ProtocolType.Ethereum]: BaseEvmAdapter,
  };
}

describe('MultiProtocolApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider();
    it('creates an app class and gleans types from generic', async () => {
      const app = new TestMultiProtocolApp(multiProvider);
      expect(app).to.be.instanceOf(MultiProtocolApp);
      expect(app.adapter(Chains.ethereum)).to.eql({});
    });
  });
});
