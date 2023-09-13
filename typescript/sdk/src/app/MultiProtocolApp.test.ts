import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

import {
  BaseAppAdapter,
  BaseEvmAdapter,
  BaseSealevelAdapter,
  MultiProtocolApp,
} from './MultiProtocolApp';

class TestMultiProtocolApp extends MultiProtocolApp<BaseAppAdapter> {
  override protocolToAdapter(protocol: ProtocolType) {
    if (protocol === ProtocolType.Ethereum) return BaseEvmAdapter;
    if (protocol === ProtocolType.Sealevel) return BaseSealevelAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }
}

describe('MultiProtocolApp', () => {
  describe('constructs', () => {
    const multiProvider = new MultiProtocolProvider();
    it('creates an app class and gleans types from generic', async () => {
      const app = new TestMultiProtocolApp(multiProvider, {});
      expect(app).to.be.instanceOf(MultiProtocolApp);
      expect(app.adapter(Chains.ethereum).protocol).to.eql(
        ProtocolType.Ethereum,
      );
    });
  });
});
