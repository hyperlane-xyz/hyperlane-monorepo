import { expect } from 'chai';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { UnsupportedHookArtifactTypeError } from '@hyperlane-xyz/provider-sdk/hook';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';

import { AleoHookArtifactManager } from './hook-artifact-manager.js';

describe('AleoHookArtifactManager', () => {
  it('rejects unsupported writers', () => {
    const hookType = AltVM.HookType.PROTOCOL_FEE;

    // CAST: Unsupported dispatch must fail before the client or signer is accessed.
    const manager = new AleoHookArtifactManager(
      {} as AnyAleoNetworkClient,
      'mailbox.aleo',
    );
    const unusedSigner = {} as AleoSigner;

    expect(() => manager.createWriter(hookType, unusedSigner))
      .to.throw(
        UnsupportedHookArtifactTypeError,
        `Unsupported hook artifact type ${hookType} for protocol ${ProtocolType.Aleo}`,
      )
      .with.property('hookType', hookType);
  });
});
