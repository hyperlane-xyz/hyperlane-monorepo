import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  TokenType,
  UnsupportedWarpArtifactTypeError,
} from '@hyperlane-xyz/provider-sdk/warp';

import { type CosmosNativeSigner } from '../clients/signer.js';

import { CosmosWarpArtifactManager } from './warp-artifact-manager.js';

describe('CosmosWarpArtifactManager', () => {
  const warpType = TokenType.native;
  const manager = new CosmosWarpArtifactManager(['http://localhost:26657']);

  it('rejects unsupported readers before connecting to RPC', () => {
    expect(() => manager.createReader(warpType))
      .to.throw(UnsupportedWarpArtifactTypeError)
      .with.property('protocol', ProtocolType.CosmosNative);
  });

  it('rejects unsupported writers before using the signer', () => {
    // CAST: Unsupported dispatch must fail before the signer is accessed.
    const unusedSigner = {} as CosmosNativeSigner;

    expect(() => manager.createWriter(warpType, unusedSigner))
      .to.throw(UnsupportedWarpArtifactTypeError)
      .with.property('warpType', warpType);
  });
});
