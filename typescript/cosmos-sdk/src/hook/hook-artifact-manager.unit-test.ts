import { expect } from 'chai';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { UnsupportedHookArtifactTypeError } from '@hyperlane-xyz/provider-sdk/hook';

import { type CosmosNativeSigner } from '../clients/signer.js';

import { CosmosHookArtifactManager } from './hook-artifact-manager.js';

describe('CosmosHookArtifactManager', () => {
  const hookType = AltVM.HookType.PROTOCOL_FEE;
  const manager = new CosmosHookArtifactManager({
    rpcUrls: ['http://localhost:26657'],
    nativeTokenDenom: 'uatom',
  });

  it('rejects unsupported readers before connecting to RPC', () => {
    expect(() => manager.createReader(hookType))
      .to.throw(
        UnsupportedHookArtifactTypeError,
        `Unsupported hook artifact type ${hookType} for protocol ${ProtocolType.CosmosNative}`,
      )
      .with.property('protocol', ProtocolType.CosmosNative);
  });

  it('rejects unsupported writers before using the signer', () => {
    // CAST: Unsupported dispatch must fail before the signer is accessed.
    const unusedSigner = {} as CosmosNativeSigner;

    expect(() => manager.createWriter(hookType, unusedSigner))
      .to.throw(
        UnsupportedHookArtifactTypeError,
        `Unsupported hook artifact type ${hookType} for protocol ${ProtocolType.CosmosNative}`,
      )
      .with.property('hookType', hookType);
  });
});
