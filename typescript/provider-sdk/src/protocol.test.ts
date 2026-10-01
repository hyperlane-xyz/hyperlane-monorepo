import { expect } from 'chai';

import {
  isProtocolChainAddresses,
  type ProtocolArtifactManagerContext,
  type ProtocolChainAddresses,
  type ProtocolProviderContext,
} from './protocol.js';

describe('ProtocolChainAddresses', () => {
  it('keeps protocol-specific registry addresses optional', () => {
    const addresses: ProtocolChainAddresses = {
      mailbox: 'mailbox',
      validatorAnnounce: 'validator-announce',
      interchainSecurityModule: 'interchain-security-module',
      merkleTreeHook: 'merkle-tree-hook',
      quotedCalls: 'quoted-calls',
    };

    expect(addresses.mailbox).to.equal('mailbox');
    expect(addresses['quotedCalls']).to.equal('quoted-calls');
  });

  it('supports partial addresses only while composing artifacts', () => {
    const context: ProtocolArtifactManagerContext = {
      addresses: { mailbox: 'mailbox' },
    };

    expect(context.addresses).to.deep.equal({ mailbox: 'mailbox' });
  });

  it('requires complete addresses in the provider context', () => {
    const addresses: ProtocolChainAddresses = {
      mailbox: 'mailbox',
      validatorAnnounce: 'validator-announce',
      interchainSecurityModule: 'interchain-security-module',
      merkleTreeHook: 'merkle-tree-hook',
    };
    const context: ProtocolProviderContext = { addresses };

    expect(context.addresses).to.equal(addresses);
  });

  it('narrows complete core address sets', () => {
    expect(
      isProtocolChainAddresses({
        mailbox: 'mailbox',
        validatorAnnounce: 'validator-announce',
        interchainSecurityModule: 'interchain-security-module',
        merkleTreeHook: 'merkle-tree-hook',
      }),
    ).to.equal(true);
    expect(isProtocolChainAddresses({ mailbox: 'mailbox' })).to.equal(false);
  });
});
