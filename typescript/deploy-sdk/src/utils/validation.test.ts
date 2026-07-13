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
      validateIsmType('compositeIsm', 'solanamainnet', ProtocolType.Sealevel);
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
        validateIsmType('compositeIsm', 'somechain', protocol);
      }).to.throw(UnsupportedIsmTypeError);
    });
  }

  it('accepts protocol-agnostic ISM types on any Alt-VM protocol', () => {
    expect(() => {
      validateIsmType('testIsm', 'somechain', ProtocolType.Radix);
    }).to.not.throw();
  });

  it('rejects unknown ISM types', () => {
    expect(() => {
      validateIsmType('notARealIsm', 'somechain', ProtocolType.Sealevel);
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
        ProtocolType.Radix,
      );
    }).to.throw(UnsupportedIsmTypeError);
  });
});
