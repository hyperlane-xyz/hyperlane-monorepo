import { expect } from 'chai';

import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import { MultiProtocolApp } from './MultiProtocolApp';

class TestMultiProtocolApp extends MultiProtocolApp {}

describe('MultiProtocolApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider();
    it('creates an app class and gleans types from generic', async () => {
      const app = new TestMultiProtocolApp(multiProvider);
      expect(app).to.be.instanceOf(MultiProtocolApp);
      expect(app.adapter(Chains.ethereum).protocol).to.eql(Chains.ethereum);
    });
  });
});
