import { expect } from 'chai';
import sinon from 'sinon';

import { AleoProvider } from '@hyperlane-xyz/aleo-sdk/runtime';

import { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';

import { AleoHypSyntheticAdapter } from './AleoTokenAdapter.js';

describe('AleoHypTokenAdapter.populateTransferRemoteTx', () => {
  const token = 'test_token.aleo';
  const sender = 'aleo_sender';
  const recipient = '0x1111111111111111111111111111111111111111';
  const recipientBytes32 = recipient.replace('0x', '').padStart(64, '0');
  const destination = 1;
  const customHook = 'custom_hook';
  const gasLimit = '100000';
  const denom = 'credits';
  const transaction = {
    programName: token,
    functionName: 'transfer_remote',
    priorityFee: 0,
    privateFee: false,
    inputs: [],
  };

  function setup() {
    const provider = sinon.createStubInstance(AleoProvider);
    provider.quoteRemoteTransfer.callsFake(async (request) => ({
      denom,
      amount: request.customHookAddress === customHook ? 100n : 10n,
    }));
    provider.getRemoteRouters.resolves({
      address: token,
      remoteRouters: [
        {
          receiverDomainId: destination,
          receiverAddress: recipientBytes32,
          gas: gasLimit,
        },
      ],
    });
    provider.getRemoteTransferTransaction.resolves(transaction);
    const multiProvider = sinon.createStubInstance(MultiProviderAdapter);
    multiProvider.getAleoProvider.returns(provider);
    const adapter = new AleoHypSyntheticAdapter('aleo', multiProvider, {
      token,
    });
    return { adapter, provider };
  }

  for (const { hook, expectedFee } of [
    { hook: undefined, expectedFee: 10n },
    { hook: customHook, expectedFee: 100n },
  ]) {
    it(`quotes the ${hook ? 'custom' : 'default'} hook used by the transfer`, async () => {
      const { adapter, provider } = setup();
      const result = await adapter.populateTransferRemoteTx({
        weiAmountOrId: 1n,
        destination,
        recipient,
        fromAccountOwner: sender,
        customHook: hook,
      });

      sinon.assert.calledOnceWithExactly(provider.quoteRemoteTransfer, {
        tokenAddress: token,
        destinationDomainId: destination,
        customHookAddress: hook,
      });
      sinon.assert.calledOnceWithExactly(
        provider.getRemoteTransferTransaction,
        {
          signer: sender,
          tokenAddress: token,
          destinationDomainId: destination,
          recipient: recipientBytes32,
          amount: '1',
          customHookAddress: hook,
          gasLimit,
          maxFee: { denom, amount: expectedFee.toString() },
        },
      );
      expect(result).to.equal(transaction);
    });
  }

  it('uses the provided quote without quoting the hook again', async () => {
    const { adapter, provider } = setup();
    await adapter.populateTransferRemoteTx({
      weiAmountOrId: 1n,
      destination,
      recipient,
      fromAccountOwner: sender,
      customHook,
      interchainGas: { igpQuote: { addressOrDenom: denom, amount: 999n } },
    });

    sinon.assert.notCalled(provider.quoteRemoteTransfer);
    sinon.assert.calledOnce(provider.getRemoteTransferTransaction);
    const [request] = provider.getRemoteTransferTransaction.firstCall.args;
    expect(request.customHookAddress).to.equal(customHook);
    expect(request.maxFee).to.deep.equal({ denom, amount: '999' });
  });
});
