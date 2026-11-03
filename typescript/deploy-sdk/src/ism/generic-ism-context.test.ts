import { expect } from 'chai';
import sinon from 'sinon';

import {
  ChainMetadataForAltVM,
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { ProtocolProvider } from '@hyperlane-xyz/provider-sdk/protocol';

import { createIsmReader } from './generic-ism.js';
import { IsmWriter, createIsmWriter } from './generic-ism-writer.js';

// CAST: registers a synthetic protocol so the test cannot collide with a real
// protocol provider registered by another suite in the same process.
const TestProtocol = 'test-ism-context' as ProtocolType;

const createIsmArtifactManager = sinon.stub();

const mockProtocolProvider: ProtocolProvider = {
  createProvider: sinon.stub(),
  createSigner: sinon.stub(),
  createSubmitter: sinon.stub(),
  createIsmArtifactManager,
  createHookArtifactManager: sinon.stub(),
  createMailboxArtifactManager: sinon.stub(),
  createValidatorAnnounceArtifactManager: sinon.stub(),
  createFeeArtifactManager: sinon.stub(),
  getMinGas: sinon.stub(),
  createWarpArtifactManager: sinon.stub(),
};

if (!hasProtocol(TestProtocol)) {
  registerProtocol(TestProtocol, () => mockProtocolProvider);
}

const chainMetadata: ChainMetadataForAltVM = {
  name: 'solanatest',
  chainId: 1,
  domainId: 1399811149,
  protocol: TestProtocol,
};

const domainIds: Record<string, number | null> = {
  solanatest: 1399811149,
  ethereum: 1,
  polygon: 137,
};

const chainLookup: ChainLookup = {
  getChainMetadata: () => chainMetadata,
  getChainName: () => null,
  getDomainId: (chain) => domainIds[String(chain)] ?? null,
  getKnownChainNames: () => Object.keys(domainIds),
  getKnownDomainIds: () => new Set([1399811149, 1, 137]),
};

describe('ISM artifact manager context', () => {
  beforeEach(() => {
    createIsmArtifactManager.reset();
    createIsmArtifactManager.returns({});
  });

  it('createIsmReader passes the unique known domain ids', () => {
    createIsmReader(chainMetadata, chainLookup);

    expect(createIsmArtifactManager.calledOnce).to.equal(true);
    expect(createIsmArtifactManager.firstCall.args).to.deep.equal([
      chainMetadata,
      { knownDomainIds: [1399811149, 1, 137] },
    ]);
  });

  it('createIsmWriter passes the unique known domain ids', () => {
    // CAST: test double, the writer only stores the signer.
    const signer = {} as unknown as ISigner<AnnotatedTx, TxReceipt>;

    createIsmWriter(chainMetadata, chainLookup, signer);

    expect(createIsmArtifactManager.calledOnce).to.equal(true);
    expect(createIsmArtifactManager.firstCall.args).to.deep.equal([
      chainMetadata,
      { knownDomainIds: [1399811149, 1, 137] },
    ]);
  });
});

describe('ISM artifact manager context without known domains', () => {
  it('creates managers without a context when the lookup has no domains', () => {
    createIsmArtifactManager.reset();
    createIsmArtifactManager.returns({});
    const emptyLookup: ChainLookup = {
      getChainMetadata: () => chainMetadata,
      getChainName: () => null,
      getDomainId: () => null,
      getKnownChainNames: () => [],
      getKnownDomainIds: () => new Set(),
    };
    // CAST: test double, the writer only stores the signer.
    const signer = {} as unknown as ISigner<AnnotatedTx, TxReceipt>;

    createIsmReader(chainMetadata, emptyLookup);
    createIsmWriter(chainMetadata, emptyLookup, signer);

    expect(createIsmArtifactManager.callCount).to.equal(2);
    for (const call of createIsmArtifactManager.getCalls()) {
      expect(call.args).to.deep.equal([chainMetadata, undefined]);
    }
  });
});

describe('IsmWriter.update routingMessageIdMultisigIsm', () => {
  it('delegates to the typed writer rather than treating the ISM as immutable', async () => {
    const txs: AnnotatedTx[] = [{ annotation: 'set validators' }];
    const update = sinon.stub().resolves(txs);
    const createWriter = sinon.stub().returns({ update });
    // CAST: test doubles exposing only the members IsmWriter.update uses.
    const manager = { createWriter } as unknown as IRawIsmArtifactManager;
    const signer = {} as unknown as ISigner<AnnotatedTx, TxReceipt>;
    const artifact: DeployedIsmArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'routingMessageIdMultisigIsm',
        owner: 'owner',
        domains: { 1: { validators: ['0x1'], threshold: 1 } },
      },
      deployed: { address: 'program' },
    };

    const result = await new IsmWriter(manager, chainLookup, signer).update(
      artifact,
    );

    expect(result).to.equal(txs);
    expect(createWriter.firstCall.args[0]).to.equal(
      'routingMessageIdMultisigIsm',
    );
    expect(update.firstCall.args[0]).to.deep.equal(artifact);
  });
});
