import sinon from 'sinon';
import { expect } from 'vitest';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookArtifact,
  IRawHookArtifactManager,
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { HookWriter } from './hook-writer.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: () => null,
  getChainName: () => null,
  getKnownChainNames: () => [],
};

describe('HookWriter', () => {
  it('delegates protocolFee updates to the protocol writer', async () => {
    const expectedTxs = [
      { annotation: 'protocol fee update' },
    ] as AnnotatedTx[];
    const update = sinon.stub().resolves(expectedTxs);
    const createWriter = sinon.stub().returns({
      create: sinon.stub(),
      read: sinon.stub(),
      update,
    });
    const artifactManager = {
      createReader: sinon.stub(),
      createWriter,
      readHook: sinon.stub(),
    } as IRawHookArtifactManager;
    const signer = {} as AltVM.ISigner<AnnotatedTx, TxReceipt>;
    const writer = new HookWriter(artifactManager, chainLookup, signer);
    const artifact: DeployedHookArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: '0xowner',
        beneficiary: '0xbeneficiary',
        maxProtocolFee: '100',
        protocolFee: '10',
      },
      deployed: { address: '0x123' },
    };

    const txs = await writer.update(artifact);

    expect(
      createWriter.calledOnceWith(AltVM.HookType.PROTOCOL_FEE, signer),
    ).toBe(true);
    expect(update.calledOnceWith(artifact)).toBe(true);
    expect(txs).toEqual(expectedTxs);
  });

  it('treats unknownHook updates as a no-op', async () => {
    const createWriter = sinon.stub();
    const artifactManager = {
      createReader: sinon.stub(),
      createWriter,
      readHook: sinon.stub(),
    } as IRawHookArtifactManager;
    const signer = {} as AltVM.ISigner<AnnotatedTx, TxReceipt>;
    const writer = new HookWriter(artifactManager, chainLookup, signer);
    const artifact: DeployedHookArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'unknownHook',
      },
      deployed: { address: '0x123' },
    };

    const txs = await writer.update(artifact);

    expect(createWriter.called).toBe(false);
    expect(txs).toEqual([]);
  });
});
