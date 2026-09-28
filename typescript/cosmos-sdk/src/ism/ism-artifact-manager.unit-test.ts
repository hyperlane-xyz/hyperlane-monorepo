import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  IsmType,
  UnsupportedIsmArtifactTypeError,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type CosmosNativeSigner } from '../clients/signer.js';

import { CosmosIsmArtifactManager } from './ism-artifact-manager.js';

describe('CosmosIsmArtifactManager', () => {
  const ismType = IsmType.PAUSABLE;
  const manager = new CosmosIsmArtifactManager(['http://localhost:26657']);

  it('rejects unsupported readers before connecting to RPC', () => {
    expect(() => manager.createReader(ismType))
      .to.throw(UnsupportedIsmArtifactTypeError)
      .with.property('protocol', ProtocolType.CosmosNative);
  });

  it('rejects unsupported writers before using the signer', () => {
    // CAST: Unsupported dispatch must fail before the signer is accessed.
    const unusedSigner = {} as CosmosNativeSigner;

    expect(() => manager.createWriter(ismType, unusedSigner))
      .to.throw(UnsupportedIsmArtifactTypeError)
      .with.property('ismType', ismType);
  });
});
