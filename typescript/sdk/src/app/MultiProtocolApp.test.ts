import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import {
  BaseAppAdapter,
  BaseCosmWasmAdapter,
  BaseEvmAdapter,
  BaseSealevelAdapter,
  MultiProtocolApp,
} from './MultiProtocolApp.js';

class TestMultiProtocolApp extends MultiProtocolApp<BaseAppAdapter> {
  override protocolToAdapter(protocol: ProtocolType) {
    if (protocol === ProtocolType.Ethereum) return BaseEvmAdapter;
    if (protocol === ProtocolType.Sealevel) return BaseSealevelAdapter;
    if (protocol === ProtocolType.Cosmos) return BaseCosmWasmAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }
}

describe('MultiProtocolApp', () => {
  const multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();
  it('creates an app class and gleans types from generic', async () => {
    const addresses = {
      test1: {},
    };
    const app = new TestMultiProtocolApp(
      multiProvider.intersect(Object.keys(addresses)).result,
      addresses,
    );
    expect(app).to.be.instanceOf(MultiProtocolApp);
    expect(app.adapter(TestChainName.test1).protocol).to.eql(
      ProtocolType.Ethereum,
    );
  });
});
