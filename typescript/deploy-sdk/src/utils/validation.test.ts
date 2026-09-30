import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { IsmType, type IsmConfig } from '@hyperlane-xyz/provider-sdk/ism';

import {
  UnsupportedIsmTypeError,
  validateIsmConfig,
  validateIsmType,
} from './validation.js';

describe('validateIsmType', () => {
  it('accepts compositeIsm on Sealevel', () => {
    expect(() => {
      validateIsmType(
        IsmType.COMPOSITE,
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
        validateIsmType(
          IsmType.COMPOSITE,
          'somechain',
          'configuration',
          protocol,
        );
      }).to.throw(UnsupportedIsmTypeError);
    });
  }

  it('accepts protocol-agnostic ISM types on any Alt-VM protocol', () => {
    expect(() => {
      validateIsmType(
        IsmType.TEST_ISM,
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

  for (const ismType of [IsmType.OP_STACK, IsmType.CCIP, IsmType.BLACKLIST]) {
    it(`rejects recognized but unsupported ${ismType}`, () => {
      expect(() => {
        validateIsmType(
          ismType,
          'somechain',
          'configuration',
          ProtocolType.Sealevel,
        );
      }).to.throw(UnsupportedIsmTypeError);
    });
  }
});

describe('validateIsmType legacy calls (no protocol)', () => {
  it('accepts a 2-arg call (chain only, default context)', () => {
    expect(() => {
      validateIsmType(IsmType.TEST_ISM, 'somechain');
    }).to.not.throw();
  });

  it('accepts a 3-arg call with an explicit context string in the old position', () => {
    expect(() => {
      validateIsmType(IsmType.TEST_ISM, 'somechain', 'core config');
    }).to.not.throw();
  });

  it('rejects compositeIsm when protocol is omitted', () => {
    expect(() => {
      validateIsmType(IsmType.COMPOSITE, 'somechain', 'core config');
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
    const config: IsmConfig = {
      type: IsmType.ROUTING,
      owner: '0x0',
      domains: {
        ethereum: {
          type: IsmType.COMPOSITE,
          owner: '0x0',
          root: { type: 'test', accept: true },
        },
      },
    };
    expect(() => {
      validateIsmConfig(
        config,
        'somechain',
        'configuration',
        ProtocolType.Radix,
      );
    }).to.throw(UnsupportedIsmTypeError);
  });

  it('rejects a recognized but unsupported ISM nested in a domainRoutingIsm', () => {
    const config: IsmConfig = {
      type: IsmType.ROUTING,
      owner: '0x0',
      domains: {
        ethereum: {
          type: IsmType.PAUSABLE,
          owner: '0x0',
          paused: false,
        },
      },
    };

    expect(() => {
      validateIsmConfig(
        config,
        'somechain',
        'configuration',
        ProtocolType.Sealevel,
      );
    }).to.throw(UnsupportedIsmTypeError);
  });

  it('accepts a legacy 2-arg call with no context/protocol', () => {
    expect(() => {
      validateIsmConfig({ type: IsmType.TEST_ISM }, 'somechain');
    }).to.not.throw();
  });
});
