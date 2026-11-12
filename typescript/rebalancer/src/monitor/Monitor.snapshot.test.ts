import { expect } from 'chai';
import { providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import {
  EvmHypCollateralAdapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MonitorEventType } from '../interfaces/IMonitor.js';
import { Monitor } from './Monitor.js';

describe('Monitor collateral snapshots', () => {
  afterEach(() => Sinon.restore());

  for (const failure of ['snapshot boundary', 'historical balance']) {
    it(`defers the whole collateral poll on failed ${failure}`, async () => {
      const provider = Sinon.createStubInstance(providers.JsonRpcProvider);
      const multiProvider = Sinon.createStubInstance(MultiProtocolProvider);
      multiProvider.getChainMetadata.returns({
        name: 'ethereum',
        chainId: 1,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.invalid' }],
      });
      multiProvider.getEthersV5Provider.returns(provider);
      provider.send.resolves('0x64');
      const token = new Token({
        chainName: 'ethereum',
        addressOrDenom: '0x1111111111111111111111111111111111111111',
        decimals: 6,
        name: 'Test',
        symbol: 'T',
        standard: TokenStandard.EvmHypCollateral,
      });
      const adapter = Sinon.createStubInstance(EvmHypCollateralAdapter);
      Sinon.stub(token, 'getHypAdapter').returns(adapter);
      adapter.getBridgedSupply.rejects(new Error('historical unavailable'));
      if (failure === 'snapshot boundary')
        provider.send.rejects(new Error('head unavailable'));
      const warpCore = Sinon.createStubInstance(WarpCore);
      Object.defineProperty(warpCore, 'tokens', { value: [token] });
      Object.defineProperty(warpCore, 'multiProvider', {
        value: multiProvider,
      });
      const monitor = new Monitor(0, warpCore, pino({ level: 'silent' }));
      let emitted = false;
      let failed = false;
      monitor.on(MonitorEventType.TokenInfo, () => {
        emitted = true;
        void monitor.stop();
      });
      monitor.on(MonitorEventType.Error, () => {
        failed = true;
        void monitor.stop();
      });
      await monitor.start();
      expect(failed).to.equal(true);
      expect(emitted).to.equal(false);
      expect(adapter.getBridgedSupply.callCount).to.equal(
        failure === 'historical balance' ? 1 : 0,
      );
      if (failure === 'historical balance')
        expect(adapter.getBridgedSupply.firstCall.args[0]).to.deep.equal({
          blockTag: 68,
        });
    });
  }
});
