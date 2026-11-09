import { expect } from 'chai';
import { rejects } from 'node:assert/strict';
import sinon from 'sinon';
import { RpcProvider } from 'starknet';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { test1 } from '../../consts/testChains.js';
import { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import {
  StarknetHypFeeAdapter,
  StarknetHypNativeAdapter,
} from './StarknetTokenAdapter.js';

describe('Starknet native and fee token automatic IGP quotes', () => {
  const warpRouter = '0x123';
  const params = {
    weiAmountOrId: 1n,
    destination: 1,
    recipient: '0x0000000000000000000000000000000000001234',
  };

  for (const Adapter of [StarknetHypNativeAdapter, StarknetHypFeeAdapter]) {
    describe(Adapter.name, () => {
      function setup() {
        const provider = new RpcProvider({
          nodeUrl: 'http://127.0.0.1:1',
          specVersion: '0.8.1',
        });
        // Decode a real Cairo uint256 quote and encode transfer calldata with
        // the generated contract ABIs; only the RPC request is stubbed.
        const rpc = sinon
          .stub(provider, 'callContract')
          .resolves(['0x64', '0x123']);
        const multiProvider = sinon.createStubInstance(MultiProviderAdapter);
        multiProvider.getStarknetProvider.returns(provider);
        multiProvider.getChainMetadata.returns({
          ...test1,
          name: 'starknet',
          protocol: ProtocolType.Starknet,
          nativeToken: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: 18,
            denom: '0x456',
          },
        });
        const adapter = new Adapter('starknet', multiProvider, { warpRouter });
        return { adapter, rpc };
      }

      it('quotes omitted interchain gas and preserves both uint128 limbs in the transfer', async () => {
        const { adapter, rpc } = setup();
        const transfer = await adapter.populateTransferRemoteTx(params);

        sinon.assert.calledOnce(rpc);
        const [request] = rpc.firstCall.args;
        expect(request.contractAddress).to.equal(warpRouter);
        expect(request.entrypoint).to.equal('quote_gas_payment');
        expect(request.calldata).to.deep.equal(['1']);
        expect(transfer.contractAddress).to.equal(warpRouter);
        expect(transfer.entrypoint).to.equal('transfer_remote');
        expect(transfer.calldata).to.deep.equal([
          '1',
          '4660',
          '0',
          '1',
          '0',
          '100',
          '291',
          '1',
          '1',
        ]);
      });

      for (const amount of [0n, 999n]) {
        it(`honors a provided ${amount} quote without another RPC request`, async () => {
          const { adapter, rpc } = setup();
          const transfer = await adapter.populateTransferRemoteTx({
            ...params,
            interchainGas: { igpQuote: { amount } },
          });

          sinon.assert.notCalled(rpc);
          expect(transfer.calldata).to.deep.equal([
            '1',
            '4660',
            '0',
            '1',
            '0',
            amount.toString(),
            '0',
            '1',
            '1',
          ]);
        });
      }

      it('propagates quote failures instead of constructing an unfunded transfer', async () => {
        const { adapter, rpc } = setup();
        rpc.rejects(new Error('quote unavailable'));
        await rejects(
          adapter.populateTransferRemoteTx(params),
          (error: unknown) => {
            expect(String(error)).to.include('quote unavailable');
            return true;
          },
        );
      });
    });
  }
});
