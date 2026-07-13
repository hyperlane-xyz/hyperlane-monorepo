import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import {
  UnsupportedIsmTypeError,
  validateIsmConfig,
  validateIsmType,
} from './validation.js';

describe('validateIsmType', () => {
  it('accepts compositeIsm on Sealevel', () => {
    expect(() => {
      validateIsmType(
        'compositeIsm',
        'solanamainnet',
        'configuration',
        ProtocolType.Sealevel,
      );
    }).to.not.throw();
  });

  for (const protocol of [
    ProtocolType.Radix,
    ProtocolType.Aleo,
    ProtocolType.Cosmos,
    ProtocolType.CosmosNative,
    ProtocolType.Starknet,
  ]) {
    it(`rejects compositeIsm on ${protocol}`, () => {
      expect(() => {
        validateIsmType('compositeIsm', 'somechain', 'configuration', protocol);
      }).to.throw(UnsupportedIsmTypeError);
    });
  }

  it('accepts protocol-agnostic ISM types on any Alt-VM protocol', () => {
    expect(() => {
      validateIsmType(
        'testIsm',
        'somechain',
        'configuration',
        ProtocolType.Radix,
      );
    }).to.not.throw();
  });

  it('rejects unknown ISM types', () => {
    expect(() => {
      validateIsmType(
        'notARealIsm',
        'somechain',
        'configuration',
        ProtocolType.Sealevel,
      );
    }).to.throw(UnsupportedIsmTypeError);
  });
});

describe('validateIsmType legacy calls (no protocol)', () => {
  it('accepts a 2-arg call (chain only, default context)', () => {
    expect(() => {
      validateIsmType('testIsm', 'somechain');
    }).to.not.throw();
  });

  it('accepts a 3-arg call with an explicit context string in the old position', () => {
    expect(() => {
      validateIsmType('testIsm', 'somechain', 'core config');
    }).to.not.throw();
  });

  it('rejects compositeIsm with a clear "protocol required" error when protocol is omitted', () => {
    // compositeIsm never existed as a supported type before protocol
    // awareness was added — there's no legacy call shape to preserve
    // permissiveness for. Omitting protocol must still reject it (just
    // with a clearer reason), not silently accept it for every protocol.
    expect(() => {
      validateIsmType('compositeIsm', 'somechain', 'core config');
    }).to.throw(UnsupportedIsmTypeError, /requires the chain's protocol/);
  });

  it('still rejects a genuinely unsupported type with no protocol given', () => {
    expect(() => {
      validateIsmType('notARealIsm', 'somechain', 'core config');
    }).to.throw(UnsupportedIsmTypeError);
  });
});

describe('validateIsmConfig', () => {
  it('rejects compositeIsm nested in a domainRoutingIsm on a non-Sealevel chain', () => {
    expect(() => {
      validateIsmConfig(
        {
          type: 'domainRoutingIsm',
          owner: '0x0',
          domains: {
            ethereum: {
              type: 'compositeIsm',
              owner: '0x0',
              root: { type: 'test', accept: true },
            },
          },
        },
        'somechain',
        'configuration',
        ProtocolType.Radix,
      );
    }).to.throw(UnsupportedIsmTypeError);
  });

  it('accepts a legacy 2-arg call with no context/protocol', () => {
    expect(() => {
      validateIsmConfig({ type: 'testIsm' }, 'somechain');
    }).to.not.throw();
  });
});
