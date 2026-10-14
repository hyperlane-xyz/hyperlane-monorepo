import { expect } from 'chai';
import { describe, it } from 'mocha';

import { IsmType } from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../clients/signer.js';
import { createRpc } from '../rpc.js';

import { SvmIsmArtifactManager } from './ism-artifact-manager.js';
import {
  SvmRoutingMessageIdMultisigIsmReader,
  SvmRoutingMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { SvmTestIsmReader, SvmTestIsmWriter } from './test-ism.js';

const ROUTING_ERROR = 'routingMessageIdMultisigIsm requires known domain ids';

describe('SvmIsmArtifactManager', () => {
  const rpc = createRpc('http://127.0.0.1:8899');
  // CAST: test double; the ISM readers and writers built here only store the
  // signer and never call it.
  const signer = {} as unknown as SvmSigner;

  it('creates a test ISM reader and writer without known domain ids', () => {
    const manager = new SvmIsmArtifactManager(rpc);
    expect(manager.createReader(IsmType.TEST_ISM)).to.be.instanceOf(
      SvmTestIsmReader,
    );
    expect(manager.createWriter(IsmType.TEST_ISM, signer)).to.be.instanceOf(
      SvmTestIsmWriter,
    );
  });

  it('creates a routing message-id multisig writer from known domain ids', () => {
    const manager = new SvmIsmArtifactManager(rpc, [1, 137]);
    expect(
      manager.createWriter(IsmType.ROUTING_MESSAGE_ID_MULTISIG, signer),
    ).to.be.instanceOf(SvmRoutingMessageIdMultisigIsmWriter);
  });

  it('rejects a routing message-id multisig writer without known domain ids', () => {
    const manager = new SvmIsmArtifactManager(rpc);
    expect(() =>
      manager.createWriter(IsmType.ROUTING_MESSAGE_ID_MULTISIG, signer),
    ).to.throw(ROUTING_ERROR);
  });

  it('rejects a flat message-id multisig writer', () => {
    const manager = new SvmIsmArtifactManager(rpc, [1]);
    expect(() =>
      manager.createWriter(IsmType.MESSAGE_ID_MULTISIG, signer),
    ).to.throw('unsupported on SVM');
  });

  it('creates a routing message-id multisig reader from known domain ids', () => {
    const manager = new SvmIsmArtifactManager(rpc, [1, 137]);
    expect(
      manager.createReader(IsmType.ROUTING_MESSAGE_ID_MULTISIG),
    ).to.be.instanceOf(SvmRoutingMessageIdMultisigIsmReader);
  });

  it('rejects the routing message-id multisig type without known domain ids', () => {
    const manager = new SvmIsmArtifactManager(rpc);
    expect(() =>
      manager.createReader(IsmType.ROUTING_MESSAGE_ID_MULTISIG),
    ).to.throw(ROUTING_ERROR);
  });

  it('rejects the flat message-id multisig type', () => {
    const manager = new SvmIsmArtifactManager(rpc, [1]);
    expect(() => manager.createReader(IsmType.MESSAGE_ID_MULTISIG)).to.throw(
      'unsupported on SVM',
    );
  });
});
