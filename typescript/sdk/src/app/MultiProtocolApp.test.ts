import { expect } from 'chai';

import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { MultiProtocolApp } from './MultiProtocolApp';

describe('MultiProtocolApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider();
    it('creates an app class and gleans types from generic', async () => {
      const app = new MultiProtocolApp(
        {
          [Chains.ethereum]: {},
        },
        multiProvider,
      );
      expect(app).to.be.instanceOf(MultiProtocolApp);
      expect(app.adapter(Chains.ethereum)).to.eql({});
    });
  });
});
