import { expect } from 'chai';
import { serialize } from 'borsh';
import { PublicKey } from '@solana/web3.js';
import { accounts } from '@sqds/multisig';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { defaultMultisigConfigs } from '../consts/multisigIsm.js';
import {
  formatUnknownInstructionWarning,
  formatUnknownProgramWarning,
  SYSTEM_PROGRAM_ID,
  SquadsTransactionReader,
} from './transaction-reader.js';
import {
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmInstructionName,
  SealevelMultisigIsmInstructionType,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelMultisigIsmTransferOwnershipInstruction,
  SealevelMultisigIsmTransferOwnershipInstructionSchema,
} from '../ism/serialization.js';
import {
  SealevelMailboxInstructionName,
  SealevelMailboxInstructionType,
  SealevelMailboxSetDefaultIsmInstruction,
  SealevelMailboxSetDefaultIsmInstructionSchema,
} from '../mailbox/serialization.js';
import {
  SealevelEnrollRemoteRouterInstruction,
  SealevelEnrollRemoteRouterInstructionSchema,
  SealevelEnrollRemoteRoutersInstruction,
  SealevelEnrollRemoteRoutersInstructionSchema,
  SealevelGasRouterConfig,
  SealevelHypTokenInstruction,
  SealevelHypTokenInstructionName,
  SealevelHypTokenTransferOwnershipInstruction,
  SealevelHypTokenTransferOwnershipInstructionSchema,
  SealevelRemoteRouterConfig,
  SealevelSetDestinationGasConfigsInstruction,
  SealevelSetDestinationGasConfigsInstructionSchema,
} from '../token/adapters/serialization.js';
import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';
import {
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SquadsAccountType,
  SquadsInstructionName,
  SquadsInstructionType,
} from './utils.js';

function createReaderWithLookupCounter(): {
  reader: SquadsTransactionReader;
  getLookupCount: () => number;
} {
  let lookupCount = 0;
  const mpp = {
    getSolanaWeb3Provider: () => {
      lookupCount += 1;
      throw new Error('provider lookup should not run for invalid indices');
    },
  } as unknown as MultiProtocolProvider;

  const reader = new SquadsTransactionReader(mpp, {
    resolveCoreProgramIds: () => ({
      mailbox: 'mailbox-program-id',
      multisig_ism_message_id: 'multisig-ism-program-id',
    }),
  });

  return {
    reader,
    getLookupCount: () => lookupCount,
  };
}

function createNoopMpp(): MultiProtocolProvider {
  return {
    getSolanaWeb3Provider: () =>
      ({
        getAccountInfo: async () => null,
      }) as unknown as ReturnType<
        MultiProtocolProvider['getSolanaWeb3Provider']
      >,
  } as unknown as MultiProtocolProvider;
}

async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

function createUnstringifiableError(): { toString: () => string } {
  return {
    toString: () => {
      throw new Error('unable to stringify');
    },
  };
}

function createUnstringifiableErrorWithMessage(message: string): {
  message: string;
  toString: () => string;
} {
  return {
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  };
}

function createUnstringifiableErrorWithStackAndMessage(
  stack: string,
  message: string,
): { stack: string; message: string; toString: () => string } {
  return {
    stack,
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  };
}

function createUnstringifiableErrorWithThrowingStackGetter(message: string): {
  message: string;
  toString: () => string;
  stack?: string;
} {
  const errorLikeObject = {
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  } as { message: string; toString: () => string; stack?: string };
  Object.defineProperty(errorLikeObject, 'stack', {
    configurable: true,
    get() {
      throw new Error('stack unavailable');
    },
  });
  return errorLikeObject;
}

function createStringifiableErrorWithThrowingStackAndMessage(
  stringifiedValue: string,
): { toString: () => string; stack?: string; message?: string } {
  const errorLikeObject = {
    toString: () => stringifiedValue,
  } as { toString: () => string; stack?: string; message?: string };
  Object.defineProperty(errorLikeObject, 'stack', {
    configurable: true,
    get() {
      throw new Error('stack unavailable');
    },
  });
  Object.defineProperty(errorLikeObject, 'message', {
    configurable: true,
    get() {
      throw new Error('message unavailable');
    },
  });
  return errorLikeObject;
}

function createErrorWithUnstringifiableMessage(): Error {
  const error = new Error('boom');
  Object.defineProperty(error, 'message', {
    configurable: true,
    get() {
      throw new Error('message unavailable');
    },
  });
  return error;
}

function createErrorWithGenericObjectStringification(): Error {
  const error = new Error('boom');
  Object.defineProperty(error, 'message', {
    configurable: true,
    get() {
      return '';
    },
  });
  error.toString = () => '[object ErrorLike]';
  return error;
}

function createSetValidatorsAndThresholdInstructionData(
  domain: number,
  validatorByteValue: number,
): Buffer {
  const validator = new Uint8Array(20).fill(validatorByteValue);
  const payload = serialize(
    SealevelMultisigIsmSetValidatorsInstructionSchema,
    new SealevelInstructionWrapper({
      instruction:
        SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD,
      data: new SealevelMultisigIsmSetValidatorsInstruction({
        domain,
        validators: [validator],
        threshold: 1,
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

function createEnrollRemoteRouterInstructionData(
  domain: number,
  routerByteValue: number,
): Buffer {
  const router = new Uint8Array(32).fill(routerByteValue);
  const payload = serialize(
    SealevelEnrollRemoteRouterInstructionSchema,
    new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.EnrollRemoteRouter,
      data: new SealevelEnrollRemoteRouterInstruction({
        config: new SealevelRemoteRouterConfig({ domain, router }),
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

function createEnrollRemoteRoutersInstructionData(domain: number): Buffer {
  const payload = serialize(
    SealevelEnrollRemoteRoutersInstructionSchema,
    new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.EnrollRemoteRouters,
      data: new SealevelEnrollRemoteRoutersInstruction({
        configs: [new SealevelRemoteRouterConfig({ domain, router: null })],
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

function createSetDestinationGasConfigsInstructionData(
  domain: number,
  gas: bigint,
): Buffer {
  const payload = serialize(
    SealevelSetDestinationGasConfigsInstructionSchema,
    new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.SetDestinationGasConfigs,
      data: new SealevelSetDestinationGasConfigsInstruction({
        configs: [new SealevelGasRouterConfig({ domain, gas })],
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

function createMailboxSetDefaultIsmInstructionData(
  ismByteValue: number,
): Buffer {
  return Buffer.from(
    serialize(
      SealevelMailboxSetDefaultIsmInstructionSchema,
      new SealevelInstructionWrapper({
        instruction: SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM,
        data: new SealevelMailboxSetDefaultIsmInstruction({
          newIsm: new Uint8Array(32).fill(ismByteValue),
        }),
      }),
    ),
  );
}

function createMultisigTransferOwnershipInstructionData(
  ownerByteValue: number,
): Buffer {
  const payload = serialize(
    SealevelMultisigIsmTransferOwnershipInstructionSchema,
    new SealevelInstructionWrapper({
      instruction: SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP,
      data: new SealevelMultisigIsmTransferOwnershipInstruction({
        newOwner: new Uint8Array(32).fill(ownerByteValue),
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

function createWarpTransferOwnershipInstructionData(
  ownerByteValue: number,
): Buffer {
  const payload = serialize(
    SealevelHypTokenTransferOwnershipInstructionSchema,
    new SealevelInstructionWrapper({
      instruction: SealevelHypTokenInstruction.TransferOwnership,
      data: new SealevelHypTokenTransferOwnershipInstruction({
        newOwner: new Uint8Array(32).fill(ownerByteValue),
      }),
    }),
  );
  return Buffer.concat([Buffer.alloc(8), Buffer.from(payload)]);
}

describe('squads transaction reader warning formatters', () => {
  it('formats unknown program warnings using trimmed program id values', () => {
    expect(
      formatUnknownProgramWarning(' 11111111111111111111111111111111 '),
    ).to.equal('⚠️  UNKNOWN PROGRAM: 11111111111111111111111111111111');
  });

  it('throws for malformed unknown-program warning program ids', () => {
    expect(() => formatUnknownProgramWarning(null)).to.throw(
      'Expected program id to be a string, got null',
    );
    expect(() => formatUnknownProgramWarning(1)).to.throw(
      'Expected program id to be a string, got number',
    );
    expect(() => formatUnknownProgramWarning('   ')).to.throw(
      'Expected program id to be a non-empty string, got empty string',
    );
  });

  it('labels unreadable unknown-program warning program ids deterministically', () => {
    const { proxy: revokedProgramId, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => formatUnknownProgramWarning(revokedProgramId)).to.throw(
      'Expected program id to be a string, got [unreadable value type]',
    );
  });

  it('formats unknown instruction warnings using normalized inputs', () => {
    expect(formatUnknownInstructionWarning(' Mailbox ', 1)).to.equal(
      'Unknown Mailbox instruction (discriminator: 1)',
    );
  });

  it('accepts byte-range discriminator boundaries for unknown instruction warnings', () => {
    expect(formatUnknownInstructionWarning('Mailbox', 0)).to.equal(
      'Unknown Mailbox instruction (discriminator: 0)',
    );
    expect(formatUnknownInstructionWarning('Mailbox', 255)).to.equal(
      'Unknown Mailbox instruction (discriminator: 255)',
    );
  });

  it('throws for malformed unknown-instruction warning inputs', () => {
    expect(() => formatUnknownInstructionWarning(null, 1)).to.throw(
      'Expected program name to be a string, got null',
    );
    expect(() => formatUnknownInstructionWarning('Mailbox', '1')).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got string',
    );
    expect(() => formatUnknownInstructionWarning('Mailbox', -1)).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got -1',
    );
    expect(() => formatUnknownInstructionWarning('Mailbox', 1.5)).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got 1.5',
    );
    expect(() => formatUnknownInstructionWarning('Mailbox', 256)).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got 256',
    );
    expect(() =>
      formatUnknownInstructionWarning('Mailbox', Number.POSITIVE_INFINITY),
    ).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got Infinity',
    );
    expect(() =>
      formatUnknownInstructionWarning('Mailbox', Number.NaN),
    ).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got NaN',
    );
    expect(() => formatUnknownInstructionWarning('  ', 1)).to.throw(
      'Expected program name to be a non-empty string, got empty string',
    );
  });

  it('labels unreadable unknown-instruction warning inputs deterministically', () => {
    const { proxy: revokedProgramName, revoke: revokeProgramName } =
      Proxy.revocable({}, {});
    revokeProgramName();
    expect(() =>
      formatUnknownInstructionWarning(revokedProgramName, 1),
    ).to.throw(
      'Expected program name to be a string, got [unreadable value type]',
    );

    const { proxy: revokedDiscriminator, revoke: revokeDiscriminator } =
      Proxy.revocable({}, {});
    revokeDiscriminator();
    expect(() =>
      formatUnknownInstructionWarning('Mailbox', revokedDiscriminator),
    ).to.throw(
      'Expected discriminator to be a non-negative safe integer in byte range [0, 255], got [unreadable value type]',
    );
  });
});

describe('squads transaction reader multisig verification', () => {
  function createReaderForVerification(
    resolveExpectedMultisigConfig?: (
      chain: string,
    ) => Record<
      string,
      { threshold: number; validators: readonly string[] }
    > | null,
    tryGetChainName?: (domain: number) => string | undefined,
  ): SquadsTransactionReader {
    const mpp = {
      tryGetChainName:
        tryGetChainName ??
        ((domain: number) => (domain === 1000 ? 'solanatestnet' : undefined)),
      getSolanaWeb3Provider: () => ({
        getAccountInfo: async () => null,
      }),
    } as unknown as MultiProtocolProvider;

    return new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig,
    });
  }

  it('matches expected route configuration when threshold and validators align', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return {
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a', 'validator-b'],
        },
      };
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
      'validator-b',
    ]);

    expect(result).to.deep.equal({ matches: true, issues: [] });
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('reuses cached expected configuration across repeated verification checks', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return {
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a', 'validator-b'],
        },
      };
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a', 'validator-b'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a', 'validator-b'],
    );

    expect(firstResult).to.deep.equal({ matches: true, issues: [] });
    expect(secondResult).to.deep.equal({ matches: true, issues: [] });
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('matches validator sets case-insensitively during verification', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 2,
        validators: ['VALidator-A', 'validator-b'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
      'VALIDATOR-B',
    ]);

    expect(result).to.deep.equal({ matches: true, issues: [] });
  });

  it('returns unknown-domain issue before loading expected configuration', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 999, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: ['Unknown domain 999'],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-chain-resolution issue when resolver returns empty chain names', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => '   ' as unknown as string,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed chain resolution for domain 1000: Error: Expected resolved chain name for domain 1000 to be a non-empty string, got empty string',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-chain-resolution issue when resolver returns non-string values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => ({ chain: 'solanatestnet' }) as unknown as string,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed chain resolution for domain 1000: Error: Expected resolved chain name for domain 1000 to be a string, got object',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-chain-resolution issue when resolver returns falsy non-null values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => 0 as unknown as string,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed chain resolution for domain 1000: Error: Expected resolved chain name for domain 1000 to be a string, got number',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-chain-resolution issue when resolver returns boolean false', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => false as unknown as string,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed chain resolution for domain 1000: Error: Expected resolved chain name for domain 1000 to be a string, got boolean',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-chain-resolution issue when resolver returns unreadable values', () => {
    let resolveConfigCallCount = 0;
    const { proxy: revokedChain, revoke } = Proxy.revocable({}, {});
    revoke();
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => revokedChain as unknown as string,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed resolved chain for domain 1000: expected string, got [unreadable value type]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('normalizes padded chain-resolution values before route lookup', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => '  solanatestnet  ',
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({ matches: true, issues: [] });
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('returns malformed-domain issue before chain resolution and config loading', () => {
    let tryGetChainNameCallCount = 0;
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        tryGetChainNameCallCount += 1;
        return 'solanatestnet';
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration(
      'solanamainnet',
      '1000' as unknown as number,
      2,
      ['validator-a'],
    );

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed remote domain for solanamainnet: expected non-negative safe integer, got string',
      ],
    });
    expect(tryGetChainNameCallCount).to.equal(0);
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-domain issue for negative domain values before lookups', () => {
    let tryGetChainNameCallCount = 0;
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        tryGetChainNameCallCount += 1;
        return 'solanatestnet';
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', -1, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed remote domain for solanamainnet: expected non-negative safe integer, got -1',
      ],
    });
    expect(tryGetChainNameCallCount).to.equal(0);
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-domain issue for NaN domain values before lookups', () => {
    let tryGetChainNameCallCount = 0;
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        tryGetChainNameCallCount += 1;
        return 'solanatestnet';
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration(
      'solanamainnet',
      Number.NaN,
      2,
      ['validator-a'],
    );

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed remote domain for solanamainnet: expected non-negative safe integer, got NaN',
      ],
    });
    expect(tryGetChainNameCallCount).to.equal(0);
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure before loading expected configuration', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        throw new Error('chain resolver failed');
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to resolve chain for domain 1000: Error: chain resolver failed',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when resolver throws unreadable values', () => {
    let resolveConfigCallCount = 0;
    const { proxy: revokedChainResolverError, revoke } = Proxy.revocable(
      {},
      {},
    );
    revoke();
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        throw revokedChainResolverError;
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to resolve chain for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when resolver throws blank Error messages', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        throw new Error('   ');
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to resolve chain for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure using fallback formatting for generic object Error messages', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        throw new Error('[object Object]');
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to resolve chain for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure using fallback formatting for bare Error labels', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => {
        throw new Error('Error');
      },
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to resolve chain for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure when chain-resolver accessor throws', () => {
    let resolveConfigCallCount = 0;
    const mpp = new Proxy(
      {
        getSolanaWeb3Provider: () => ({
          getAccountInfo: async () => null,
        }),
      },
      {
        get(target, property, receiver) {
          if (property === 'tryGetChainName') {
            throw new Error('chain resolver accessor failed');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig: () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to read tryGetChainName for domain 1000: Error: chain resolver accessor failed',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when chain-resolver accessor throws blank Error messages', () => {
    let resolveConfigCallCount = 0;
    const mpp = new Proxy(
      {
        getSolanaWeb3Provider: () => ({
          getAccountInfo: async () => null,
        }),
      },
      {
        get(target, property, receiver) {
          if (property === 'tryGetChainName') {
            throw new Error('   ');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig: () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to read tryGetChainName for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when chain-resolver accessor throws generic-object Error messages', () => {
    let resolveConfigCallCount = 0;
    const mpp = new Proxy(
      {
        getSolanaWeb3Provider: () => ({
          getAccountInfo: async () => null,
        }),
      },
      {
        get(target, property, receiver) {
          if (property === 'tryGetChainName') {
            throw new Error('[object Object]');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig: () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to read tryGetChainName for domain 1000: [unstringifiable error]',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure when chain-resolver function is missing', () => {
    let resolveConfigCallCount = 0;
    const mpp = {
      getSolanaWeb3Provider: () => ({
        getAccountInfo: async () => null,
      }),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig: () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Invalid multi protocol provider for domain 1000: expected tryGetChainName function, got undefined',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure for promise-like chain-resolution values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () => Promise.resolve('solanatestnet') as unknown as string | undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Invalid resolved chain for domain 1000: expected synchronous string result, got promise-like value',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure when resolved-chain promise-like inspection fails', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('then unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as string | undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to inspect resolved chain for domain 1000: failed to read promise-like then field (Error: then unavailable)',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when resolved-chain promise-like inspection throws generic-object Error messages', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('[object Object]');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as string | undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to inspect resolved chain for domain 1000: failed to read promise-like then field ([unstringifiable error])',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when resolved-chain promise-like inspection throws bare Error labels', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('Error:');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as string | undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to inspect resolved chain for domain 1000: failed to read promise-like then field ([unstringifiable error])',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns chain-resolution failure with placeholders when resolved-chain promise-like inspection throws opaque values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(
      () => {
        resolveConfigCallCount += 1;
        return {
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a'],
          },
        };
      },
      () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw {};
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as string | undefined,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Failed to inspect resolved chain for domain 1000: failed to read promise-like then field ([unstringifiable error])',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-threshold issue before loading expected configuration', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return {
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a'],
        },
      };
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 0, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator threshold for route solanamainnet -> solanatestnet: threshold must be a positive safe integer, got 0',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed-threshold issue for non-number thresholds before config loading', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return {
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a'],
        },
      };
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      '2' as unknown as number,
      ['validator-a'],
    );

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator threshold for route solanamainnet -> solanatestnet: threshold must be a positive safe integer, got string',
      ],
    });
    expect(resolveConfigCallCount).to.equal(0);
  });

  it('returns malformed expected-config-map issue when resolver returns non-object values', () => {
    const reader = createReaderForVerification(
      () =>
        'not-an-object' as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for solanamainnet: expected route map object',
      ],
    });
  });

  it('returns malformed route-entry issue when resolver returns unreadable route objects', () => {
    const reader = createReaderForVerification(() => {
      const { proxy: revokedRouteEntry, revoke } = Proxy.revocable({}, {});
      revoke();
      return {
        solanatestnet: revokedRouteEntry,
      } as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: expected route entry object',
      ],
    });
  });

  it('caches null expected config when resolver throws', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      throw new Error('resolver failed');
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when resolver returns promise-like values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return Promise.resolve({
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a'],
        },
      }) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when promise-like then access throws', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw new Error('then getter failed');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when promise-like then access throws generic-object Error messages', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw new Error('[object Object]');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when promise-like then access throws blank Error messages', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw new Error('   ');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when promise-like then access throws bare Error labels', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw new Error('Error:');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when promise-like then access throws opaque values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      return new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when resolver returns unreadable object values', () => {
    let resolveConfigCallCount = 0;
    const reader = createReaderForVerification(() => {
      resolveConfigCallCount += 1;
      const { proxy: revokedConfig, revoke } = Proxy.revocable({}, {});
      revoke();
      return revokedConfig as unknown as Record<
        string,
        { threshold: number; validators: readonly string[] }
      >;
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolveConfigCallCount).to.equal(1);
  });

  it('caches null expected config when resolver accessor throws', () => {
    let resolverAccessorReadCount = 0;
    const mpp = {
      tryGetChainName: (domain: number) =>
        domain === 1000 ? 'solanatestnet' : undefined,
      getSolanaWeb3Provider: () => ({
        getAccountInfo: async () => null,
      }),
    } as unknown as MultiProtocolProvider;

    const reader = new SquadsTransactionReader(
      mpp,
      new Proxy(
        {
          resolveCoreProgramIds: () => ({
            mailbox: 'mailbox-program-id',
            multisig_ism_message_id: 'multisig-ism-program-id',
          }),
          resolveExpectedMultisigConfig: () => ({
            solanatestnet: {
              threshold: 2,
              validators: ['validator-a'],
            },
          }),
        },
        {
          get(target, property, receiver) {
            if (property === 'resolveExpectedMultisigConfig') {
              resolverAccessorReadCount += 1;
              throw new Error('resolver accessor failed');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    );

    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const firstResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );
    const secondResult = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      ['validator-a'],
    );

    expect(firstResult).to.deep.equal({
      matches: false,
      issues: ['No expected config found for solanamainnet'],
    });
    expect(secondResult).to.deep.equal(firstResult);
    expect(resolverAccessorReadCount).to.equal(1);
  });

  it('surfaces missing route-specific expected configuration', () => {
    const reader = createReaderForVerification(() => ({
      solanadevnet: {
        threshold: 2,
        validators: ['validator-a'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: ['No expected config for route solanamainnet -> solanatestnet'],
    });
  });

  it('reports malformed route config access when route lookup throws', () => {
    const reader = createReaderForVerification(
      () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'solanatestnet') {
                throw new Error('route read failed');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: failed to read route entry (Error: route read failed)',
      ],
    });
  });

  it('reports malformed route entries when expected route config is not an object', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: 'invalid-route-entry',
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: expected route entry object',
      ],
    });
  });

  it('reports malformed route entries when expected route config is boolean false', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: false,
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: expected route entry object',
      ],
    });
  });

  it('reports malformed expected threshold access when getter throws', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: new Proxy(
            {},
            {
              get(target, property) {
                if (property === 'threshold') {
                  throw new Error('threshold read failed');
                }
                return Reflect.get(target, property);
              },
            },
          ),
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: failed to read threshold (Error: threshold read failed)',
      ],
    });
  });

  it('reports malformed expected validator access when getter throws', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: new Proxy(
            { threshold: 2 },
            {
              get(target, property) {
                if (property === 'validators') {
                  throw new Error('validator read failed');
                }
                return Reflect.get(target, property);
              },
            },
          ),
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: failed to read validators (Error: validator read failed)',
      ],
    });
  });

  it('reports malformed expected threshold values for route config', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: {
            threshold: '2',
            validators: ['validator-a'],
          },
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: threshold must be a positive safe integer',
      ],
    });
  });

  it('reports malformed expected validator arrays for route config', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a', ''],
          },
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: validators must be an array of non-empty strings',
      ],
    });
  });

  it('reports malformed expected validator arrays when duplicates exist', () => {
    const reader = createReaderForVerification(
      () =>
        ({
          solanatestnet: {
            threshold: 2,
            validators: ['validator-a', 'VALIDATOR-A'],
          },
        }) as unknown as Record<
          string,
          { threshold: number; validators: readonly string[] }
        >,
    );
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: validators must be unique (duplicate: VALIDATOR-A)',
      ],
    });
  });

  it('reports malformed validator sets from instruction payloads', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 2,
        validators: ['validator-a'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
      null,
    ] as unknown as readonly string[]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator set for route solanamainnet -> solanatestnet: validators must be an array of non-empty strings',
      ],
    });
  });

  it('reports malformed expected validator arrays when array inspection is unreadable', () => {
    const reader = createReaderForVerification(() => {
      const { proxy: revokedValidators, revoke } = Proxy.revocable({}, {});
      revoke();
      return {
        solanatestnet: {
          threshold: 2,
          validators: revokedValidators as unknown as readonly string[],
        },
      };
    });
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed expected config for route solanamainnet -> solanatestnet: validators must be an array of non-empty strings',
      ],
    });
  });

  it('reports malformed runtime validator arrays when duplicates exist', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 2,
        validators: ['validator-a', 'validator-b'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
      'VALIDATOR-A',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator set for route solanamainnet -> solanatestnet: validators must be unique (duplicate: VALIDATOR-A)',
      ],
    });
  });

  it('reports malformed runtime validator arrays when array inspection is unreadable', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 2,
        validators: ['validator-a'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };
    const { proxy: revokedValidators, revoke } = Proxy.revocable({}, {});
    revoke();

    const result = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      revokedValidators as unknown as readonly string[],
    );

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator set for route solanamainnet -> solanatestnet: validators must be an array of non-empty strings',
      ],
    });
  });

  it('reports malformed runtime validator access when iteration throws', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 2,
        validators: ['validator-a'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const runtimeValidators = new Proxy(['validator-a'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('validator iterator failed');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = readerAny.verifyConfiguration(
      'solanamainnet',
      1000,
      2,
      runtimeValidators as unknown as readonly string[],
    );

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Malformed validator set for route solanamainnet -> solanatestnet: failed to read validators (Error: validator iterator failed)',
      ],
    });
  });

  it('reports threshold and validator-set mismatches with detailed issues', () => {
    const reader = createReaderForVerification(() => ({
      solanatestnet: {
        threshold: 3,
        validators: ['validator-a', 'validator-b', 'validator-c'],
      },
    }));
    const readerAny = reader as unknown as {
      verifyConfiguration: (
        originChain: string,
        remoteDomain: number,
        threshold: number,
        validators: readonly string[],
      ) => { matches: boolean; issues: string[] };
    };

    const result = readerAny.verifyConfiguration('solanamainnet', 1000, 2, [
      'validator-a',
      'validator-d',
    ]);

    expect(result).to.deep.equal({
      matches: false,
      issues: [
        'Threshold mismatch: expected 3, got 2',
        'Validator count mismatch: expected 3, got 2',
        'Missing validators: validator-b, validator-c',
        'Unexpected validators: validator-d',
      ],
    });
  });
});

describe('squads transaction reader', () => {
  function createMockProposalData(
    transactionIndex: unknown,
  ): Record<string, unknown> {
    return {
      proposal: {
        status: { __kind: 'Active' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex,
      },
      proposalPda: new PublicKey('11111111111111111111111111111111'),
      multisigPda: new PublicKey('11111111111111111111111111111111'),
      programId: new PublicKey('11111111111111111111111111111111'),
    };
  }

  it('fails fast when warp-route init input is not an object', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const error = await captureAsyncError(() =>
      reader.init('malformed routes'),
    );

    expect(error?.message).to.equal(
      'Expected warp routes to be an object, got string',
    );
  });

  it('throws contextual error when warp-route entries accessor fails', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const hostileWarpRoutes = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('entries unavailable');
        },
      },
    );

    const error = await captureAsyncError(() => reader.init(hostileWarpRoutes));

    expect(error?.message).to.equal(
      'Failed to read warp routes entries: Error: entries unavailable',
    );
  });

  it('uses placeholder when warp-route entries accessor throws opaque object', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const hostileWarpRoutes = new Proxy(
      {},
      {
        ownKeys() {
          throw {};
        },
      },
    );

    const error = await captureAsyncError(() => reader.init(hostileWarpRoutes));

    expect(error?.message).to.equal(
      'Failed to read warp routes entries: [unstringifiable error]',
    );
  });

  it('skips warp-route tokens when protocol lookup throws during initialization', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: (chain: string) => {
        protocolLookupCount += 1;
        if (chain === 'badchain') {
          throw new Error('protocol lookup failed');
        }
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'badchain',
            addressOrDenom: 'BAD001',
            symbol: 'BAD',
            name: 'Bad Token',
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(2);
    expect(reader.warpRouteIndex.has('badchain')).to.equal(false);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good001'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips warp-route tokens when protocol lookup throws unreadable values during initialization', async () => {
    let protocolLookupCount = 0;
    const { proxy: revokedProtocolError, revoke } = Proxy.revocable({}, {});
    revoke();
    const mpp = {
      tryGetProtocol: (chain: string) => {
        protocolLookupCount += 1;
        if (chain === 'badchain') {
          throw revokedProtocolError;
        }
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'badchain',
            addressOrDenom: 'BAD001-UNREADABLE',
            symbol: 'BAD',
            name: 'Bad Token',
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-UNREADABLE',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(2);
    expect(reader.warpRouteIndex.has('badchain')).to.equal(false);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good001-unreadable'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips warp-route tokens when protocol lookup throws blank Error messages during initialization', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: (chain: string) => {
        protocolLookupCount += 1;
        if (chain === 'badchain') {
          throw new Error('   ');
        }
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'badchain',
            addressOrDenom: 'BAD001-BLANK',
            symbol: 'BAD',
            name: 'Bad Token',
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-BLANK',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(2);
    expect(reader.warpRouteIndex.has('badchain')).to.equal(false);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good001-blank'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips warp-route tokens when protocol lookup throws generic-object Error messages during initialization', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: (chain: string) => {
        protocolLookupCount += 1;
        if (chain === 'badchain') {
          throw new Error('[object Object]');
        }
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'badchain',
            addressOrDenom: 'BAD001-GENERIC',
            symbol: 'BAD',
            name: 'Bad Token',
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-GENERIC',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(2);
    expect(reader.warpRouteIndex.has('badchain')).to.equal(false);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good001-generic'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips warp-route tokens when protocol lookup accessor throws during initialization', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'tryGetProtocol') {
            throw new Error('protocol accessor unavailable');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-ACCESSOR',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup accessor throws blank Error messages during initialization', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'tryGetProtocol') {
            throw new Error('   ');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-ACCESSOR-BLANK',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup accessor throws generic-object Error messages during initialization', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'tryGetProtocol') {
            throw new Error('[object Object]');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-ACCESSOR-GENERIC',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup function is missing during initialization', async () => {
    const mpp = {} as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-MISSING',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup returns promise-like values', async () => {
    const mpp = {
      tryGetProtocol: async () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-PROMISE',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup returns null', async () => {
    const mpp = {
      tryGetProtocol: () => null,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-NULL-PROTOCOL',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('skips warp-route tokens when protocol lookup returns ProtocolType.Unknown', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Unknown,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-UNKNOWN-PROTOCOL',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('throws contextual errors for malformed protocol lookup value types', () => {
    const mpp = {
      tryGetProtocol: () => 1,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Invalid protocol for warp route routeA on solanamainnet: expected ProtocolType or null, got number',
    );
  });

  it('throws placeholder fallbacks when protocol lookup accessor throws generic-object Error messages', () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'tryGetProtocol') {
            throw new Error('[object Object]');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to read tryGetProtocol for warp route routeA on solanamainnet: [unstringifiable error]',
    );
  });

  it('throws contextual errors when protocol lookup returns undefined', () => {
    const mpp = {
      tryGetProtocol: () => undefined,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Invalid protocol for warp route routeA on solanamainnet: expected ProtocolType or null, got undefined',
    );
  });

  it('throws contextual errors for malformed protocol lookup string values', () => {
    const mpp = {
      tryGetProtocol: () => 'not-a-protocol',
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Invalid protocol for warp route routeA on solanamainnet: expected ProtocolType or null, got not-a-protocol',
    );
  });

  it('throws contextual errors when protocol promise-like inspection throws', () => {
    const mpp = {
      tryGetProtocol: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('then unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to inspect protocol for warp route routeA on solanamainnet: failed to read promise-like then field (Error: then unavailable)',
    );
  });

  it('throws placeholder fallbacks when protocol promise-like inspection throws blank Error messages', () => {
    const mpp = {
      tryGetProtocol: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('   ');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to inspect protocol for warp route routeA on solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('throws placeholder fallbacks when protocol promise-like inspection throws generic-object Error messages', () => {
    const mpp = {
      tryGetProtocol: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('[object Object]');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to inspect protocol for warp route routeA on solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('throws placeholder fallbacks when protocol promise-like inspection throws bare Error labels', () => {
    const mpp = {
      tryGetProtocol: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('Error:');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to inspect protocol for warp route routeA on solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('throws placeholder fallbacks when protocol promise-like inspection throws opaque values', () => {
    const mpp = {
      tryGetProtocol: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw {};
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      resolveProtocolTypeForWarpRoute: (
        routeName: string,
        chain: string,
      ) => ProtocolType | null;
    };

    expect(() =>
      readerAny.resolveProtocolTypeForWarpRoute('routeA', 'solanamainnet'),
    ).to.throw(
      'Failed to inspect protocol for warp route routeA on solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('skips warp-route tokens when protocol type inspection is unreadable', async () => {
    const mpp = {
      tryGetProtocol: () => {
        const { proxy: revokedProtocol, revoke } = Proxy.revocable({}, {});
        revoke();
        return revokedProtocol;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-UNREADABLE-PROTOCOL',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(reader.warpRouteIndex.has('solanamainnet')).to.equal(false);
  });

  it('preserves this binding for protocol lookup during warp-route initialization', async () => {
    const mpp = {
      protocol: ProtocolType.Sealevel,
      tryGetProtocol(this: { protocol: ProtocolType }, _chain: string) {
        return this.protocol;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD001-THIS',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good001-this'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips malformed warp-route addresses during initialization', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 123 as unknown as string,
            symbol: 'BAD',
            name: 'Bad Token',
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: ' GOOD002 ',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    const chainIndex = reader.warpRouteIndex.get('solanamainnet');
    expect(chainIndex?.has('123')).to.equal(false);
    expect(chainIndex?.get('good002')).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips malformed warp-route token containers when tokens accessor throws', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const malformedRoute = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'tokens') {
            throw new Error('tokens unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      malformedRoute,
      validRoute: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD003',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good003'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'validRoute',
    });
  });

  it('skips malformed warp-route token containers when token-array inspection fails', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const { proxy: revokedTokens, revoke } = Proxy.revocable({}, {});
    revoke();

    await reader.init({
      malformedRoute: {
        tokens: revokedTokens,
      },
      validRoute: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD003-REVOCABLE',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good003-revocable'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'validRoute',
    });
  });

  it('skips malformed warp-route token containers when tokens length accessor throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const hostileTokens = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('tokens length unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await reader.init({
      malformedRoute: {
        tokens: hostileTokens,
      },
      validRoute: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD003-LEN',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good003-len'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'validRoute',
    });
  });

  it('skips malformed warp-route token containers when tokens length is malformed', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const hostileTokens = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          return 1n;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await reader.init({
      malformedRoute: {
        tokens: hostileTokens,
      },
      validRoute: {
        tokens: [
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD003-LEN-TYPE',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good003-len-type'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'validRoute',
    });
  });

  it('skips malformed warp-route tokens when chain-name accessor throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const malformedToken = new Proxy(
      {
        addressOrDenom: 'BAD004',
      },
      {
        get(target, property, receiver) {
          if (property === 'chainName') {
            throw new Error('chainName unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      routeA: {
        tokens: [
          malformedToken,
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD004',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    const chainIndex = reader.warpRouteIndex.get('solanamainnet');
    expect(chainIndex?.has('bad004')).to.equal(false);
    expect(chainIndex?.get('good004')).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('skips malformed warp-route tokens when address accessor throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const malformedToken = new Proxy(
      {
        chainName: 'solanamainnet',
        symbol: 'BAD',
        name: 'Bad Token',
      },
      {
        get(target, property, receiver) {
          if (property === 'addressOrDenom') {
            throw new Error('address unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      routeA: {
        tokens: [
          malformedToken,
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD004-ADDRESS',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      },
    });

    expect(protocolLookupCount).to.equal(2);
    const chainIndex = reader.warpRouteIndex.get('solanamainnet');
    expect(chainIndex?.has('good004-address')).to.equal(true);
    expect(chainIndex?.get('good004-address')).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('uses fallback symbol when warp-route token symbol accessor throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const malformedToken = new Proxy(
      {
        chainName: 'solanamainnet',
        addressOrDenom: 'GOOD004-SYMBOL',
        name: 'Good Token',
      },
      {
        get(target, property, receiver) {
          if (property === 'symbol') {
            throw new Error('symbol unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      routeA: {
        tokens: [malformedToken],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good004-symbol'),
    ).to.deep.equal({
      symbol: 'Unknown',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  it('uses fallback name when warp-route token name accessor throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const malformedToken = new Proxy(
      {
        chainName: 'solanamainnet',
        addressOrDenom: 'GOOD004-NAME',
        symbol: 'GOOD',
      },
      {
        get(target, property, receiver) {
          if (property === 'name') {
            throw new Error('name unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      routeA: {
        tokens: [malformedToken],
      },
    });

    expect(protocolLookupCount).to.equal(1);
    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good004-name'),
    ).to.deep.equal({
      symbol: 'GOOD',
      name: 'Unknown',
      routeName: 'routeA',
    });
  });

  it('skips malformed warp-route tokens when indexed token access throws', async () => {
    let protocolLookupCount = 0;
    const mpp = {
      tryGetProtocol: () => {
        protocolLookupCount += 1;
        return ProtocolType.Sealevel;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const hostileTokens = new Proxy(
      [
        {
          chainName: 'solanamainnet',
          addressOrDenom: 'BAD004-IDX',
          symbol: 'BAD',
          name: 'Bad Token',
        },
        {
          chainName: 'solanamainnet',
          addressOrDenom: 'GOOD004-IDX',
          symbol: 'GOOD',
          name: 'Good Token',
        },
      ],
      {
        get(target, property, receiver) {
          if (property === '0') {
            throw new Error('token unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    await reader.init({
      routeA: {
        tokens: hostileTokens,
      },
    });

    expect(protocolLookupCount).to.equal(1);
    const chainIndex = reader.warpRouteIndex.get('solanamainnet');
    expect(chainIndex?.has('bad004-idx')).to.equal(false);
    expect(chainIndex?.get('good004-idx')).to.deep.equal({
      symbol: 'GOOD',
      name: 'Good Token',
      routeName: 'routeA',
    });
  });

  const invalidTransactionIndexCases: Array<{
    title: string;
    transactionIndex: unknown;
    expectedMessage: string;
  }> = [
    {
      title: 'fails fast for negative transaction index',
      transactionIndex: -1,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
    },
    {
      title: 'fails fast for non-integer transaction index',
      transactionIndex: 1.5,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got 1.5',
    },
    {
      title: 'fails fast for unsafe transaction index',
      transactionIndex: Number.MAX_SAFE_INTEGER + 1,
      expectedMessage: `Expected transaction index to be a non-negative safe integer for solanamainnet, got ${
        Number.MAX_SAFE_INTEGER + 1
      }`,
    },
    {
      title: 'fails fast for NaN transaction index',
      transactionIndex: Number.NaN,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
    },
    {
      title: 'fails fast for infinite transaction index',
      transactionIndex: Number.POSITIVE_INFINITY,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got Infinity',
    },
    {
      title: 'fails fast for string transaction index',
      transactionIndex: '1',
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
    },
    {
      title: 'fails fast for null transaction index',
      transactionIndex: null,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
    },
    {
      title: 'fails fast for array transaction index',
      transactionIndex: [],
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got array',
    },
    {
      title: 'fails fast for bigint transaction index',
      transactionIndex: 1n,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got bigint',
    },
  ];

  for (const {
    title,
    transactionIndex,
    expectedMessage,
  } of invalidTransactionIndexCases) {
    it(title, async () => {
      const { reader, getLookupCount } = createReaderWithLookupCounter();
      const thrownError = await captureAsyncError(() =>
        reader.read('solanamainnet', transactionIndex),
      );

      expect(thrownError?.message).to.equal(expectedMessage);
      expect(getLookupCount()).to.equal(0);
      expect(reader.errors).to.deep.equal([]);
    });
  }

  it('fails fast for unsupported chains before provider lookup', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() =>
      reader.read('unsupported-chain', 0),
    );

    expect(thrownError?.message).to.include(
      'Squads config not found on chain unsupported-chain',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for padded unsupported chains before provider lookup', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() =>
      reader.read('  unsupported-chain  ', 0),
    );

    expect(thrownError?.message).to.include(
      'Squads config not found on chain unsupported-chain',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for unsupported chains before transaction index validation', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() =>
      reader.read('unsupported-chain', -1),
    );

    expect(thrownError?.message).to.include(
      'Squads config not found on chain unsupported-chain',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for unsupported chains before malformed transaction-index type validation', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() =>
      reader.read('unsupported-chain', '1'),
    );

    expect(thrownError?.message).to.include(
      'Squads config not found on chain unsupported-chain',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for malformed chain names before provider lookup', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() => reader.read(1, 0));

    expect(thrownError?.message).to.equal(
      'Expected chain name to be a string, got number',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for malformed chain names before transaction index validation', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() => reader.read(1, -1));

    expect(thrownError?.message).to.equal(
      'Expected chain name to be a string, got number',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for empty chain names before provider lookup', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() => reader.read('   ', 0));

    expect(thrownError?.message).to.equal(
      'Expected chain name to be a non-empty string',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('fails fast for empty chain names before transaction index validation', async () => {
    const { reader, getLookupCount } = createReaderWithLookupCounter();

    const thrownError = await captureAsyncError(() => reader.read('   ', -1));

    expect(thrownError?.message).to.equal(
      'Expected chain name to be a non-empty string',
    );
    expect(getLookupCount()).to.equal(0);
    expect(reader.errors).to.deep.equal([]);
  });

  it('normalizes padded chain names before provider lookup and recorded errors', async () => {
    let providerLookupChain: string | undefined;
    const mpp = {
      getSolanaWeb3Provider: (chain: string) => {
        providerLookupChain = chain;
        throw new Error('provider lookup failed');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('  solanamainnet  ', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to resolve solana provider for solanamainnet: Error: provider lookup failed',
    );
    expect(providerLookupChain).to.equal('solanamainnet');
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to resolve solana provider for solanamainnet: Error: provider lookup failed',
      },
    ]);
  });

  it('uses deterministic placeholders when provider lookup throws opaque values', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => {
        throw {};
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('uses deterministic placeholders when provider lookup throws blank Error messages', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => {
        throw new Error('   ');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('uses deterministic placeholders when provider lookup throws generic-object Error messages', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => {
        throw new Error('[object Object]');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to resolve solana provider for solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('fails with contextual error when getSolanaWeb3Provider accessor throws', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'getSolanaWeb3Provider') {
            throw new Error('provider lookup accessor unavailable');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read getSolanaWeb3Provider for solanamainnet: Error: provider lookup accessor unavailable',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to read getSolanaWeb3Provider for solanamainnet: Error: provider lookup accessor unavailable',
      },
    ]);
  });

  it('fails with placeholder error when getSolanaWeb3Provider accessor throws blank Error messages', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'getSolanaWeb3Provider') {
            throw new Error('   ');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read getSolanaWeb3Provider for solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to read getSolanaWeb3Provider for solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('fails with placeholder error when getSolanaWeb3Provider accessor throws generic-object Error messages', async () => {
    const mpp = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'getSolanaWeb3Provider') {
            throw new Error('[object Object]');
          }
          return undefined;
        },
      },
    ) as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read getSolanaWeb3Provider for solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to read getSolanaWeb3Provider for solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('fails with contextual error when getSolanaWeb3Provider is missing', async () => {
    const reader = new SquadsTransactionReader(
      {} as unknown as MultiProtocolProvider,
      {
        resolveCoreProgramIds: () => ({
          mailbox: 'mailbox-program-id',
          multisig_ism_message_id: 'multisig-ism-program-id',
        }),
      },
    );

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid multi protocol provider for solanamainnet: expected getSolanaWeb3Provider function, got undefined',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid multi protocol provider for solanamainnet: expected getSolanaWeb3Provider function, got undefined',
      },
    ]);
  });

  it('fails with contextual error when provider lookup returns promise-like value', async () => {
    const mpp = {
      getSolanaWeb3Provider: async () => ({
        getAccountInfo: async () => null,
      }),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid solana provider for solanamainnet: expected synchronous provider, got promise-like value',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid solana provider for solanamainnet: expected synchronous provider, got promise-like value',
      },
    ]);
  });

  it('fails with contextual error when provider promise-like inspection fails', async () => {
    const mpp = {
      getSolanaWeb3Provider: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('then unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect solana provider for solanamainnet: failed to read promise-like then field (Error: then unavailable)',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to inspect solana provider for solanamainnet: failed to read promise-like then field (Error: then unavailable)',
      },
    ]);
  });

  it('fails with placeholder fallback when provider promise-like inspection throws generic-object Error messages', async () => {
    const mpp = {
      getSolanaWeb3Provider: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('[object Object]');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
      },
    ]);
  });

  it('fails with placeholder fallback when provider promise-like inspection throws bare Error labels', async () => {
    const mpp = {
      getSolanaWeb3Provider: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('Error:');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
      },
    ]);
  });

  it('fails with placeholder fallback when provider promise-like inspection throws opaque values', async () => {
    const mpp = {
      getSolanaWeb3Provider: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw {};
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Failed to inspect solana provider for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
      },
    ]);
  });

  it('fails with contextual error when provider is missing getAccountInfo', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => ({}),
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
      },
    ]);
  });

  it('fails with contextual error when provider is an array', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => [],
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid solana provider for solanamainnet: expected object, got array',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid solana provider for solanamainnet: expected object, got array',
      },
    ]);
  });

  it('fails with contextual error when provider type inspection is unreadable', async () => {
    const { proxy: revokedProvider, revoke } = Proxy.revocable({}, {});
    revoke();
    const mpp = {
      getSolanaWeb3Provider: () => revokedProvider,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid solana provider for solanamainnet: expected object, got [unreadable value type]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid solana provider for solanamainnet: expected object, got [unreadable value type]',
      },
    ]);
  });

  it('fails with contextual error when provider is null', async () => {
    const mpp = {
      getSolanaWeb3Provider: () => null,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 0),
    );

    expect(thrownError?.message).to.equal(
      'Invalid solana provider for solanamainnet: expected object, got null',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error:
          'Error: Invalid solana provider for solanamainnet: expected object, got null',
      },
    ]);
  });

  it('uses requested transaction index when reading config transaction', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () =>
      createMockProposalData({
        [Symbol.toPrimitive]: () => '5',
        toString: () => {
          throw new Error('proposal transactionIndex should not stringify');
        },
      });

    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });

    let observedTransactionIndex: number | undefined;
    readerAny.readConfigTransaction = async (_, transactionIndex) => {
      observedTransactionIndex = transactionIndex;
      return { chain: 'solanamainnet', transactionIndex };
    };

    const result = (await reader.read('solanamainnet', 5)) as {
      transactionIndex?: number;
    };

    expect(result.transactionIndex).to.equal(5);
    expect(observedTransactionIndex).to.equal(5);
  });

  it('keeps config transaction parsing stable when config actions iteration throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      decodeConfigTransactionForRead: () => { actions: unknown };
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    const hostileActions = new Proxy([{}], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('actions iterator unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    readerAny.decodeConfigTransactionForRead = () => ({
      actions: hostileActions,
    });

    const result = await readerAny.readConfigTransaction(
      'solanamainnet',
      5,
      createMockProposalData(5),
      {},
    );

    expect(result).to.include({
      chain: 'solanamainnet',
      transactionIndex: 5,
    });
    expect(result.instructions).to.deep.equal([]);
  });

  it('keeps config transaction parsing stable when config actions array inspection fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      decodeConfigTransactionForRead: () => { actions: unknown };
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    const { proxy: revokedActions, revoke } = Proxy.revocable({}, {});
    revoke();
    readerAny.decodeConfigTransactionForRead = () => ({
      actions: revokedActions,
    });

    const result = await readerAny.readConfigTransaction(
      'solanamainnet',
      5,
      createMockProposalData(5),
      {},
    );

    expect(result).to.include({
      chain: 'solanamainnet',
      transactionIndex: 5,
    });
    expect(result.instructions).to.deep.equal([]);
  });

  it('normalizes padded chain names before config transaction parsing', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    let observedProposalFetchChain: string | undefined;
    readerAny.fetchProposalData = async (chain) => {
      observedProposalFetchChain = chain;
      return createMockProposalData(5);
    };

    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });

    let observedConfigParseChain: string | undefined;
    readerAny.readConfigTransaction = async (chain, transactionIndex) => {
      observedConfigParseChain = chain;
      return { chain, transactionIndex };
    };

    const result = (await reader.read('  solanamainnet  ', 5)) as {
      chain: string;
      transactionIndex: number;
    };

    expect(observedProposalFetchChain).to.equal('solanamainnet');
    expect(observedConfigParseChain).to.equal('solanamainnet');
    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      transactionIndex: 5,
    });
  });

  it('normalizes padded chain names before vault transaction parsing', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    let observedProposalFetchChain: string | undefined;
    readerAny.fetchProposalData = async (chain) => {
      observedProposalFetchChain = chain;
      return createMockProposalData(5);
    };

    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        1,
      ]),
    });

    let observedVaultParseChain: string | undefined;
    readerAny.readVaultTransaction = async (chain, transactionIndex) => {
      observedVaultParseChain = chain;
      return { chain, transactionIndex };
    };

    const result = (await reader.read('  solanamainnet  ', 5)) as {
      chain: string;
      transactionIndex: number;
    };

    expect(observedProposalFetchChain).to.equal('solanamainnet');
    expect(observedVaultParseChain).to.equal('solanamainnet');
    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      transactionIndex: 5,
    });
  });

  it('fails before account lookup when proposal index mismatches request', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(7);

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Expected proposal index 5 for solanamainnet, got 7',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: Expected proposal index 5 for solanamainnet, got 7',
      },
    ]);
  });

  it('fails before account lookup when proposal index is invalid', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(true);

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Squads transaction index must be a JavaScript safe integer: true',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Squads transaction index must be a JavaScript safe integer: true',
      },
    ]);
  });

  it('fails before account lookup when proposal multisig PDA getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () =>
      new Proxy(createMockProposalData(5), {
        get(target, property, receiver) {
          if (property === 'multisigPda') {
            throw new Error('multisig unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read proposal multisig PDA for solanamainnet at index 5: Error: multisig unavailable',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Failed to read proposal multisig PDA for solanamainnet at index 5: Error: multisig unavailable',
      },
    ]);
  });

  it('fails before account lookup when proposal multisig PDA is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () => ({
      ...createMockProposalData(5),
      multisigPda: 'not-a-public-key',
    });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed proposal multisig PDA for solanamainnet at index 5: expected PublicKey, got string',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed proposal multisig PDA for solanamainnet at index 5: expected PublicKey, got string',
      },
    ]);
  });

  it('fails before account lookup when proposal multisig PDA type inspection is unreadable', async () => {
    const { proxy: revokedMultisigPda, revoke } = Proxy.revocable({}, {});
    revoke();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () => ({
      ...createMockProposalData(5),
      multisigPda: revokedMultisigPda,
    });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed proposal multisig PDA for solanamainnet at index 5: expected PublicKey, got [unreadable value type]',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed proposal multisig PDA for solanamainnet at index 5: expected PublicKey, got [unreadable value type]',
      },
    ]);
  });

  it('fails before account lookup when proposal program id getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () =>
      new Proxy(createMockProposalData(5), {
        get(target, property, receiver) {
          if (property === 'programId') {
            throw new Error('program id unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read proposal program id for solanamainnet at index 5: Error: program id unavailable',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Failed to read proposal program id for solanamainnet at index 5: Error: program id unavailable',
      },
    ]);
  });

  it('fails before account lookup when proposal program id is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () => ({
      ...createMockProposalData(5),
      programId: 0,
    });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed proposal program id for solanamainnet at index 5: expected PublicKey, got number',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed proposal program id for solanamainnet at index 5: expected PublicKey, got number',
      },
    ]);
  });

  it('fails before account lookup when proposal program id type inspection is unreadable', async () => {
    const { proxy: revokedProgramId, revoke } = Proxy.revocable({}, {});
    revoke();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };
    readerAny.fetchProposalData = async () => ({
      ...createMockProposalData(5),
      programId: revokedProgramId,
    });

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed proposal program id for solanamainnet at index 5: expected PublicKey, got [unreadable value type]',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed proposal program id for solanamainnet at index 5: expected PublicKey, got [unreadable value type]',
      },
    ]);
  });

  it('records exactly one error when vault transaction read fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readVaultTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        1,
      ]),
    });
    readerAny.readVaultTransaction = async () => {
      throw new Error('vault read failed');
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal('vault read failed');
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: vault read failed',
      },
    ]);
  });

  it('records exactly one error when config transaction read fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw new Error('config read failed');
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal('config read failed');
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: config read failed',
      },
    ]);
  });

  it('records a stable placeholder when thrown error cannot stringify', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const unstringifiableError = createUnstringifiableError();
    readerAny.readConfigTransaction = async () => {
      throw unstringifiableError;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(unstringifiableError);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('records a stable placeholder when thrown Error message is unstringifiable', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const malformedError = createErrorWithUnstringifiableMessage();
    readerAny.readConfigTransaction = async () => {
      throw malformedError;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(malformedError);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('uses placeholder when thrown Error stringifies to a generic object label', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const genericStringifiedError =
      createErrorWithGenericObjectStringification();
    readerAny.readConfigTransaction = async () => {
      throw genericStringifiedError;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(genericStringifiedError);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('records message from thrown object when stringification fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const messageBackedError =
      createUnstringifiableErrorWithMessage('config read failed');
    readerAny.readConfigTransaction = async () => {
      throw messageBackedError;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(messageBackedError);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'config read failed',
      },
    ]);
  });

  it('prefers stack over message from thrown object when stringification fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const stackBackedError = createUnstringifiableErrorWithStackAndMessage(
      'Error: config read failed\n at test.ts:1:1',
      'config read failed',
    );
    readerAny.readConfigTransaction = async () => {
      throw stackBackedError;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(stackBackedError);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: config read failed\n at test.ts:1:1',
      },
    ]);
  });

  it('uses placeholder when thrown object stringifies to generic object label', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw {};
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('falls back to message when stack accessor throws on thrown objects', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const stackThrowingErrorLikeObject =
      createUnstringifiableErrorWithThrowingStackGetter('config read failed');
    readerAny.readConfigTransaction = async () => {
      throw stackThrowingErrorLikeObject;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(stackThrowingErrorLikeObject);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'config read failed',
      },
    ]);
  });

  it('falls back to message when thrown object stack is whitespace-only', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const whitespaceStackErrorLikeObject = {
      stack: '   ',
      message: 'config read failed',
      toString() {
        return 'should not be used';
      },
    };
    readerAny.readConfigTransaction = async () => {
      throw whitespaceStackErrorLikeObject;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(whitespaceStackErrorLikeObject);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'config read failed',
      },
    ]);
  });

  it('falls back to String(error) when stack and message accessors throw', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    const stringifiableErrorLikeObject =
      createStringifiableErrorWithThrowingStackAndMessage('custom error');
    readerAny.readConfigTransaction = async () => {
      throw stringifiableErrorLikeObject;
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError).to.equal(stringifiableErrorLikeObject);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'custom error',
      },
    ]);
  });

  it('uses placeholder when String(error) fallback normalizes to empty text', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw createStringifiableErrorWithThrowingStackAndMessage('   ');
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('uses placeholder when thrown string errors are whitespace-only', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw '   ';
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('uses placeholder when thrown Error values stringify to bare labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw new Error('');
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('uses placeholder when thrown TypeError values stringify to bare labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw new TypeError('');
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: '[unstringifiable error]',
      },
    ]);
  });

  it('preserves custom Error-like thrown string labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async () => {
      throw 'RpcError';
    };

    await captureAsyncError(() => reader.read('solanamainnet', 5));

    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'RpcError',
      },
    ]);
  });

  it('records exactly one error when proposal data lookup fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => {
      throw new Error('Proposal 5 not found on solanamainnet');
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Proposal 5 not found on solanamainnet',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: Proposal 5 not found on solanamainnet',
      },
    ]);
  });

  it('records exactly one error when transaction account fetch fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<{ data: Buffer }>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => {
      throw new Error(
        'Transaction account not found at 11111111111111111111111111111111 on solanamainnet',
      );
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Transaction account not found at 11111111111111111111111111111111 on solanamainnet',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Transaction account not found at 11111111111111111111111111111111 on solanamainnet',
      },
    ]);
  });

  it('throws contextual error when transaction-account provider accessor fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: PublicKey,
        svmProvider: unknown,
      ) => Promise<unknown>;
    };
    const provider = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'getAccountInfo') {
            throw new Error('account reader unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const thrownError = await captureAsyncError(() =>
      readerAny.fetchTransactionAccount(
        'solanamainnet',
        5,
        SYSTEM_PROGRAM_ID,
        provider,
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read getAccountInfo for solanamainnet: Error: account reader unavailable',
    );
  });

  it('throws contextual error when transaction-account provider call fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: PublicKey,
        svmProvider: unknown,
      ) => Promise<unknown>;
    };
    const provider = {
      getAccountInfo: async () => {
        throw new Error('rpc unavailable');
      },
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.fetchTransactionAccount(
        'solanamainnet',
        5,
        SYSTEM_PROGRAM_ID,
        provider,
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to fetch transaction account 11111111111111111111111111111111 on solanamainnet: Error: rpc unavailable',
    );
  });

  it('records exactly one error when transaction account data getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () =>
      new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'data') {
              throw new Error('account data unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read transaction account data on solanamainnet: Error: account data unavailable',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Failed to read transaction account data on solanamainnet: Error: account data unavailable',
      },
    ]);
  });

  it('records exactly one error when transaction account data getter throws blank Error messages', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () =>
      new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'data') {
              throw new Error('   ');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read transaction account data on solanamainnet: [unstringifiable error]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Failed to read transaction account data on solanamainnet: [unstringifiable error]',
      },
    ]);
  });

  it('records exactly one error when transaction account data type is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: 7,
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed transaction account data on solanamainnet: expected bytes, got number',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed transaction account data on solanamainnet: expected bytes, got number',
      },
    ]);
  });

  it('records exactly one error when transaction account data type inspection is unreadable', async () => {
    const { proxy: revokedAccountData, revoke } = Proxy.revocable({}, {});
    revoke();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: revokedAccountData,
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed transaction account data on solanamainnet: expected bytes, got [unreadable value type]',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed transaction account data on solanamainnet: expected bytes, got [unreadable value type]',
      },
    ]);
  });

  it('uses fetched transaction account bytes without re-reading accountInfo.data', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      accountInfo: new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'data') {
              throw new Error('account data should not be re-read');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
      accountData: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async (_, transactionIndex) => ({
      chain: 'solanamainnet',
      transactionIndex,
    });

    const result = (await reader.read('solanamainnet', 5)) as {
      transactionIndex?: number;
    };

    expect(result.transactionIndex).to.equal(5);
  });

  it('records exactly one error when fetched transaction account info is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      accountInfo: 7,
      accountData: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed fetched transaction account info on solanamainnet: expected object, got number',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed fetched transaction account info on solanamainnet: expected object, got number',
      },
    ]);
  });

  it('records exactly one error when fetched transaction account bytes getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      accountInfo: { data: Buffer.alloc(0) },
      get accountData() {
        throw new Error('account bytes unavailable');
      },
    });

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read fetched transaction account bytes on solanamainnet: Error: account bytes unavailable',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Failed to read fetched transaction account bytes on solanamainnet: Error: account bytes unavailable',
      },
    ]);
  });

  it('records exactly one error when fetched transaction account container is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => 7;

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Malformed fetched transaction account on solanamainnet: expected object, got number',
    );
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Malformed fetched transaction account on solanamainnet: expected object, got number',
      },
    ]);
  });

  it('looks up solana provider once per read attempt', async () => {
    let providerLookupCount = 0;
    const provider = {
      getAccountInfo: async () => null,
    };
    const mpp = {
      getSolanaWeb3Provider: () => {
        providerLookupCount += 1;
        return provider;
      },
    } as unknown as MultiProtocolProvider;

    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: (
        chain: string,
        transactionIndex: number,
        transactionPda: unknown,
        svmProvider: unknown,
      ) => Promise<{ data: Buffer }>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async (_, __, svmProvider) => {
      expect(svmProvider).to.equal(provider);
      return createMockProposalData(5);
    };
    readerAny.fetchTransactionAccount = async (_, __, ___, svmProvider) => {
      expect(svmProvider).to.equal(provider);
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };
    readerAny.readConfigTransaction = async (_, transactionIndex) => ({
      chain: 'solanamainnet',
      transactionIndex,
    });

    const result = (await reader.read('solanamainnet', 5)) as {
      transactionIndex?: number;
    };

    expect(result.transactionIndex).to.equal(5);
    expect(providerLookupCount).to.equal(1);
  });

  it('handles throwing chain alias resolution while formatting validator instructions', () => {
    const mpp = {
      tryGetChainName: () => {
        throw new Error('chain resolver failed');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'MultisigIsmMessageId',
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: {
        domain: 1000,
        threshold: 2,
        validators: ['validator-a'],
      },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({
      domain: 1000,
      threshold: 2,
      validators: ['validator-a'],
    });
    expect(result.insight).to.equal(
      '❌ fatal mismatch: Failed to resolve chain for domain 1000: Error: chain resolver failed',
    );
  });

  it('handles malformed domain display values while formatting validator instructions', () => {
    let chainLookupCount = 0;
    const mpp = {
      tryGetChainName: () => {
        chainLookupCount += 1;
        return 'solanatestnet';
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedDomainValue = {
      toString: () => {
        throw new Error('domain toString should not run');
      },
      [Symbol.toPrimitive]: () => {
        throw new Error('domain primitive conversion should not run');
      },
    };

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'MultisigIsmMessageId',
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: {
        domain: malformedDomainValue as unknown as number,
        threshold: 2,
        validators: ['validator-a'],
      },
      accounts: [],
      warnings: [],
    });

    expect(chainLookupCount).to.equal(0);
    expect(result.insight).to.equal(
      '❌ fatal mismatch: Malformed remote domain for solanamainnet: expected non-negative safe integer, got object',
    );
  });

  it('handles malformed validator display values while formatting validator instructions', () => {
    let chainLookupCount = 0;
    const mpp = {
      tryGetChainName: () => {
        chainLookupCount += 1;
        return 'solanatestnet';
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
      resolveExpectedMultisigConfig: () => ({
        solanatestnet: {
          threshold: 2,
          validators: ['validator-a'],
        },
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedValidators = new Proxy(['validator-a'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('validators unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'MultisigIsmMessageId',
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: {
        domain: 1000,
        threshold: 2,
        validators: malformedValidators as unknown as readonly string[],
      },
      accounts: [],
      warnings: [],
    });

    expect(chainLookupCount).to.equal(2);
    expect(result.args).to.deep.equal({
      domain: 1000,
      threshold: 2,
      validators: [],
    });
    expect(result.insight).to.equal(
      '❌ fatal mismatch: Malformed validator set for route solanamainnet -> solanatestnet: failed to read validators (Error: validators unavailable)',
    );
  });

  it('keeps formatting validator instructions when default alias validators accessor throws', () => {
    const mpp = {
      tryGetChainName: () => 'solanatestnet',
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const multisigConfigs = defaultMultisigConfigs as unknown as Record<
      string,
      unknown
    >;
    const originalSolanatestnetConfig = multisigConfigs.solanatestnet;
    multisigConfigs.solanatestnet = new Proxy(
      {
        threshold: 1,
      },
      {
        get(target, property, receiver) {
          if (property === 'validators') {
            throw new Error('validators unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    try {
      const result = readerAny.formatInstruction('solanamainnet', {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'MultisigIsmMessageId',
        instructionType:
          SealevelMultisigIsmInstructionName[
            SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
          ],
        data: {
          domain: 1000,
          threshold: 1,
          validators: ['validator-a'],
        },
        accounts: [],
        warnings: [],
      });

      expect(result.args).to.deep.equal({
        domain: 1000,
        threshold: 1,
        validators: ['validator-a'],
      });
    } finally {
      multisigConfigs.solanatestnet = originalSolanatestnetConfig;
    }
  });

  it('handles throwing multisig validator payload getters while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const hostileValidatorData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (
            property === 'domain' ||
            property === 'threshold' ||
            property === 'validators'
          ) {
            throw new Error(`${String(property)} unavailable`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'MultisigIsmMessageId',
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: hostileValidatorData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({
      domain: undefined,
      threshold: undefined,
      validators: [],
    });
    expect(result.insight).to.equal(
      '❌ fatal mismatch: Malformed remote domain for solanamainnet: expected non-negative safe integer, got undefined',
    );
  });

  it('handles unreadable router-config arrays while formatting enroll-routers instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const { proxy: revokedRouters, revoke } = Proxy.revocable({}, {});
    revoke();

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouters
        ],
      data: {
        routers: revokedRouters,
      },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('handles unreadable gas-config arrays while formatting destination-gas instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const { proxy: revokedConfigs, revoke } = Proxy.revocable({}, {});
    revoke();

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetDestinationGasConfigs
        ],
      data: {
        configs: revokedConfigs,
      },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('handles router-config arrays that throw during iteration while formatting enroll-routers instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const hostileRouters = new Proxy([{}], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('routers unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouters
        ],
      data: {
        routers: hostileRouters,
      },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('handles gas-config arrays that throw during iteration while formatting destination-gas instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const hostileConfigs = new Proxy([{}], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('gas configs unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetDestinationGasConfigs
        ],
      data: {
        configs: hostileConfigs,
      },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('falls back to stable display labels when instruction metadata is malformed', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedProgramId = {
      toBase58: () => {
        throw new Error('program id unavailable');
      },
    };

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: malformedProgramId,
      programName: '   ',
      instructionType: '',
      data: {},
      accounts: [],
      warnings: [],
      insight: '   ',
    });

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Unknown ([invalid program id])',
      type: 'Unknown',
      insight: 'Unknown instruction',
    });
  });

  it('falls back to stable display labels when instruction metadata getters throw', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const hostileInstruction = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (
            property === 'instructionType' ||
            property === 'programName' ||
            property === 'programId' ||
            property === 'insight'
          ) {
            throw new Error(`${String(property)} unavailable`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction(
      'solanamainnet',
      hostileInstruction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Unknown ([invalid program id])',
      type: 'Unknown',
      insight: 'Unknown instruction',
    });
  });

  it('formats known instructions when instruction data getter throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const hostileInstruction = new Proxy(
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'Mailbox',
        instructionType:
          SealevelMailboxInstructionName[
            SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
          ],
        accounts: [],
        warnings: [],
      },
      {
        get(target, property, receiver) {
          if (property === 'data') {
            throw new Error('data unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction(
      'solanamainnet',
      hostileInstruction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Mailbox (11111111111111111111111111111111)',
      type: SealevelMailboxInstructionName[
        SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
      ],
      insight:
        SealevelMailboxInstructionName[
          SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
        ] + ' instruction',
      args: { module: null },
    });
  });

  it('handles throwing warp router alias access while formatting single-router instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedRouterData = new Proxy(
      {
        domain: 1000,
        router: '   ',
      },
      {
        get(target, property, receiver) {
          if (property === 'chainName') {
            throw new Error('chain alias unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouter
        ],
      data: malformedRouterData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({
      'domain 1000': 'unenrolled',
    });
  });

  it('handles throwing warp router-list access while formatting multi-router instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedRoutersData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'routers') {
            throw new Error('routers unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouters
        ],
      data: malformedRoutersData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('handles throwing warp gas-config access while formatting destination-gas instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedGasConfigData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'configs') {
            throw new Error('configs unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetDestinationGasConfigs
        ],
      data: malformedGasConfigData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({});
  });

  it('handles throwing mailbox default-ISM access while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedDefaultIsmData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'newDefaultIsm') {
            throw new Error('default ism unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Mailbox',
      instructionType:
        SealevelMailboxInstructionName[
          SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
        ],
      data: malformedDefaultIsmData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({ module: null });
  });

  it('handles throwing ownership-target access while formatting ownership-transfer instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedOwnershipData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'newOwner') {
            throw new Error('new owner unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const mailboxResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Mailbox',
      instructionType:
        SealevelMailboxInstructionName[
          SealevelMailboxInstructionType.TRANSFER_OWNERSHIP
        ],
      data: malformedOwnershipData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });
    const warpResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.TransferOwnership
        ],
      data: malformedOwnershipData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(mailboxResult.args).to.deep.equal({ newOwner: null });
    expect(warpResult.args).to.deep.equal({ newOwner: null });
  });

  it('normalizes malformed warp ISM and IGP values while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedIsmData = new Proxy(
      {
        ism: '   ',
      },
      {
        get(target, property, receiver) {
          if (property === 'ism') {
            throw new Error('ism unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const malformedIgpData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'igp') {
            throw new Error('igp unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const ismResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetInterchainSecurityModule
        ],
      data: malformedIsmData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });
    const igpResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetInterchainGasPaymaster
        ],
      data: malformedIgpData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(ismResult.args).to.deep.equal({ ism: null });
    expect(igpResult.args).to.deep.equal({ igp: null });
  });

  it('normalizes malformed mailbox module and non-object IGP values while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };

    const mailboxResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Mailbox',
      instructionType:
        SealevelMailboxInstructionName[
          SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
        ],
      data: { newDefaultIsm: 1 as unknown as string },
      accounts: [],
      warnings: [],
    });
    const igpResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'WarpRoute',
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.SetInterchainGasPaymaster
        ],
      data: { igp: 'bad-igp' as unknown as Record<string, unknown> },
      accounts: [],
      warnings: [],
    });

    expect(mailboxResult.args).to.deep.equal({ module: null });
    expect(igpResult.args).to.deep.equal({ igp: null });
  });

  it('handles malformed squads add-member permissions while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedAddMemberData = new Proxy(
      {
        newMember: 'member-a',
      },
      {
        get(target, property, receiver) {
          if (property === 'permissions') {
            throw new Error('permissions unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const undecodablePermissionData = {
      newMember: 'member-b',
      permissions: {
        mask: 'bad-mask',
      },
    };

    const missingPermissionsResult = readerAny.formatInstruction(
      'solanamainnet',
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'Squads',
        instructionType:
          SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
        data: malformedAddMemberData as unknown as Record<string, unknown>,
        accounts: [],
        warnings: [],
      },
    );
    const undecodablePermissionsResult = readerAny.formatInstruction(
      'solanamainnet',
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'Squads',
        instructionType:
          SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
        data: undecodablePermissionData as unknown as Record<string, unknown>,
        accounts: [],
        warnings: [],
      },
    );

    expect(missingPermissionsResult.args).to.deep.equal({
      member: 'member-a',
      permissions: {
        mask: null,
        decoded: 'Unknown',
      },
    });
    expect(undecodablePermissionsResult.args).to.deep.equal({
      member: 'member-b',
      permissions: {
        mask: 'bad-mask',
        decoded: 'Unknown',
      },
    });
  });

  it('handles malformed squads remove-member and threshold-change fields while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const malformedRemoveMemberData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'memberToRemove') {
            throw new Error('member unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const malformedChangeThresholdData = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'newThreshold') {
            throw new Error('threshold unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const removeMemberResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Squads',
      instructionType:
        SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER],
      data: malformedRemoveMemberData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });
    const changeThresholdResult = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Squads',
      instructionType:
        SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD],
      data: malformedChangeThresholdData as unknown as Record<string, unknown>,
      accounts: [],
      warnings: [],
    });

    expect(removeMemberResult.args).to.deep.equal({ member: null });
    expect(changeThresholdResult.args).to.deep.equal({ newThreshold: null });
  });

  it('normalizes non-numeric squads threshold values while formatting instructions', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatInstruction: (
        chain: string,
        instruction: Record<string, unknown>,
      ) => Record<string, unknown>;
    };

    const result = readerAny.formatInstruction('solanamainnet', {
      programId: SYSTEM_PROGRAM_ID,
      programName: 'Squads',
      instructionType:
        SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD],
      data: { newThreshold: '3' as unknown as number },
      accounts: [],
      warnings: [],
    });

    expect(result.args).to.deep.equal({ newThreshold: null });
  });

  it('returns null for hostile config actions during config-action formatting', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const malformedAction = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'newMember') {
            throw new Error('config action unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatConfigAction(
      'solanamainnet',
      malformedAction as unknown as Record<string, unknown>,
    );

    expect(result).to.equal(null);
  });

  it('keeps add-member config actions when permissions decode fails', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };

    const result = readerAny.formatConfigAction('solanamainnet', {
      __kind: 'AddMember',
      newMember: {
        key: { toBase58: () => 'member-a' },
        permissions: { mask: 'bad-mask' },
      },
    });

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
      args: {
        member: 'member-a',
        permissions: { mask: 'bad-mask', decoded: 'Unknown' },
      },
      insight: 'Add member member-a with Unknown permissions',
    });
  });

  it('keeps add-spending-limit config actions when amount stringification fails', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };

    const result = readerAny.formatConfigAction('solanamainnet', {
      __kind: 'AddSpendingLimit',
      vaultIndex: 0,
      mint: { toBase58: () => 'mint-address' },
      amount: {
        toString: () => {
          throw new Error('amount unavailable');
        },
      },
      members: [{ toBase58: () => 'member-a' }],
      destinations: [{ toBase58: () => 'destination-a' }],
    });

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: 0,
        mint: 'mint-address',
        amount: '[invalid amount]',
        members: ['member-a'],
        destinations: ['destination-a'],
      },
      insight: 'Add spending limit for vault 0',
    });
  });

  it('keeps add-spending-limit config actions when members and destinations access throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const hostileAction = new Proxy(
      {
        __kind: 'AddSpendingLimit',
        vaultIndex: 2,
        mint: { toBase58: () => 'mint-address' },
        amount: 7n,
      },
      {
        get(target, property, receiver) {
          if (property === 'members' || property === 'destinations') {
            throw new Error(`${String(property)} unavailable`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatConfigAction(
      'solanamainnet',
      hostileAction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: 2,
        mint: 'mint-address',
        amount: '7',
        members: [],
        destinations: [],
      },
      insight: 'Add spending limit for vault 2',
    });
  });

  it('keeps add-spending-limit config actions when members and destinations array inspection fails', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const { proxy: revokedMembers, revoke: revokeMembers } = Proxy.revocable(
      {},
      {},
    );
    revokeMembers();
    const { proxy: revokedDestinations, revoke: revokeDestinations } =
      Proxy.revocable({}, {});
    revokeDestinations();

    const result = readerAny.formatConfigAction('solanamainnet', {
      __kind: 'AddSpendingLimit',
      vaultIndex: 3,
      mint: { toBase58: () => 'mint-address' },
      amount: 9n,
      members: revokedMembers,
      destinations: revokedDestinations,
    });

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: 3,
        mint: 'mint-address',
        amount: '9',
        members: [],
        destinations: [],
      },
      insight: 'Add spending limit for vault 3',
    });
  });

  it('keeps add-spending-limit config actions when members and destinations iteration throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const hostileMembers = new Proxy([{ toBase58: () => 'member-a' }], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('members unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const hostileDestinations = new Proxy(
      [{ toBase58: () => 'destination-a' }],
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            throw new Error('destinations unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = readerAny.formatConfigAction('solanamainnet', {
      __kind: 'AddSpendingLimit',
      vaultIndex: 4,
      mint: { toBase58: () => 'mint-address' },
      amount: 10n,
      members: hostileMembers,
      destinations: hostileDestinations,
    });

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: 4,
        mint: 'mint-address',
        amount: '10',
        members: [],
        destinations: [],
      },
      insight: 'Add spending limit for vault 4',
    });
  });

  it('keeps add-member config actions when nested field access throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const hostileAction = {
      __kind: 'AddMember',
      get newMember() {
        return {
          key: { toBase58: () => 'member-a' },
          get permissions() {
            throw new Error('permissions unavailable');
          },
        };
      },
    };

    const result = readerAny.formatConfigAction(
      'solanamainnet',
      hostileAction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
      args: {
        member: 'member-a',
        permissions: { mask: null, decoded: 'Unknown' },
      },
      insight: 'Add member member-a with Unknown permissions',
    });
  });

  it('keeps add-spending-limit config actions when vault-index access throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const hostileAction = {
      __kind: 'AddSpendingLimit',
      get vaultIndex() {
        throw new Error('vault index unavailable');
      },
      mint: { toBase58: () => 'mint-address' },
      amount: 7n,
      members: [{ toBase58: () => 'member-a' }],
      destinations: [{ toBase58: () => 'destination-a' }],
    };

    const result = readerAny.formatConfigAction(
      'solanamainnet',
      hostileAction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: null,
        mint: 'mint-address',
        amount: '7',
        members: ['member-a'],
        destinations: ['destination-a'],
      },
      insight: 'Add spending limit for vault null',
    });
  });

  it('keeps remove-spending-limit config actions when spending-limit access throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const hostileAction = {
      __kind: 'RemoveSpendingLimit',
      get spendingLimit() {
        throw new Error('spending limit unavailable');
      },
    };

    const result = readerAny.formatConfigAction(
      'solanamainnet',
      hostileAction as unknown as Record<string, unknown>,
    );

    expect(result).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'RemoveSpendingLimit',
      args: { spendingLimit: '[invalid address]' },
      insight: 'Remove spending limit [invalid address]',
    });
  });

  it('keeps config actions with malformed address-like fields using fallback addresses', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      formatConfigAction: (
        chain: string,
        action: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };

    const addMemberResult = readerAny.formatConfigAction('solanamainnet', {
      __kind: 'AddMember',
      newMember: {
        key: { toBase58: () => '[object PublicKey]' },
        permissions: { mask: 1 },
      },
    });
    const addSpendingLimitResult = readerAny.formatConfigAction(
      'solanamainnet',
      {
        __kind: 'AddSpendingLimit',
        vaultIndex: 1,
        mint: {},
        amount: 5n,
        members: [{ toBase58: () => 'member-a' }, {}],
        destinations: 'bad-destinations',
      },
    );
    const removeSpendingLimitResult = readerAny.formatConfigAction(
      'solanamainnet',
      {
        __kind: 'RemoveSpendingLimit',
        spendingLimit: {},
      },
    );

    expect(addMemberResult).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: SquadsInstructionName[SquadsInstructionType.ADD_MEMBER],
      args: {
        member: '[invalid address]',
        permissions: { mask: 1, decoded: 'Proposer' },
      },
      insight: 'Add member [invalid address] with Proposer permissions',
    });
    expect(addSpendingLimitResult).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'AddSpendingLimit',
      args: {
        vaultIndex: 1,
        mint: '[invalid address]',
        amount: '5',
        members: ['member-a', '[invalid address]'],
        destinations: [],
      },
      insight: 'Add spending limit for vault 1',
    });
    expect(removeSpendingLimitResult).to.deep.equal({
      chain: 'solanamainnet',
      to: 'Squads Multisig Configuration',
      type: 'RemoveSpendingLimit',
      args: { spendingLimit: '[invalid address]' },
      insight: 'Remove spending limit [invalid address]',
    });
  });

  it('returns empty config instructions when config-action list access throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountInfo = accounts.ConfigTransaction.fromAccountInfo;
    (
      accounts.ConfigTransaction as unknown as {
        fromAccountInfo: (...args: unknown[]) => unknown;
      }
    ).fromAccountInfo = () => [
      new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'actions') {
              throw new Error('actions unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    ];

    try {
      const result = await readerAny.readConfigTransaction(
        'solanamainnet',
        5,
        {
          proposal: {},
          proposalPda: new PublicKey('11111111111111111111111111111111'),
          multisigPda: new PublicKey('11111111111111111111111111111111'),
        },
        { data: Buffer.alloc(0) },
      );

      expect(result.instructions).to.deep.equal([]);
    } finally {
      (
        accounts.ConfigTransaction as unknown as {
          fromAccountInfo: typeof originalFromAccountInfo;
        }
      ).fromAccountInfo = originalFromAccountInfo;
    }
  });

  it('throws stable contextual error when config transaction decoding fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountInfo = accounts.ConfigTransaction.fromAccountInfo;
    (
      accounts.ConfigTransaction as unknown as {
        fromAccountInfo: (...args: unknown[]) => unknown;
      }
    ).fromAccountInfo = () => {
      throw new Error('decode failed');
    };

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readConfigTransaction(
          'solanamainnet',
          5,
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          { data: Buffer.alloc(0) },
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to decode ConfigTransaction for solanamainnet at index 5: Error: decode failed',
      );
    } finally {
      (
        accounts.ConfigTransaction as unknown as {
          fromAccountInfo: typeof originalFromAccountInfo;
        }
      ).fromAccountInfo = originalFromAccountInfo;
    }
  });

  it('uses fallback addresses when config transaction PDAs cannot be stringified', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const malformedAddressLike = {
      toBase58: () => {
        throw new Error('address unavailable');
      },
    };
    const originalFromAccountInfo = accounts.ConfigTransaction.fromAccountInfo;
    (
      accounts.ConfigTransaction as unknown as {
        fromAccountInfo: (...args: unknown[]) => unknown;
      }
    ).fromAccountInfo = () => [{ actions: [] }];

    try {
      const result = await readerAny.readConfigTransaction(
        'solanamainnet',
        5,
        {
          proposal: {},
          proposalPda: malformedAddressLike,
          multisigPda: malformedAddressLike,
        },
        { data: Buffer.alloc(0) },
      );

      expect(result).to.deep.equal({
        chain: 'solanamainnet',
        proposalPda: '[invalid address]',
        transactionIndex: 5,
        multisig: '[invalid address]',
        instructions: [],
      });
    } finally {
      (
        accounts.ConfigTransaction as unknown as {
          fromAccountInfo: typeof originalFromAccountInfo;
        }
      ).fromAccountInfo = originalFromAccountInfo;
    }
  });

  it('throws contextual error when config transaction decoder accessor throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      accounts.ConfigTransaction,
      'fromAccountInfo',
    );
    Object.defineProperty(accounts.ConfigTransaction, 'fromAccountInfo', {
      configurable: true,
      get() {
        throw new Error('decoder unavailable');
      },
    });

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readConfigTransaction(
          'solanamainnet',
          5,
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          { data: Buffer.alloc(0) },
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read ConfigTransaction decoder for solanamainnet at index 5: Error: decoder unavailable',
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          accounts.ConfigTransaction,
          'fromAccountInfo',
          originalDescriptor,
        );
      }
    }
  });

  it('throws contextual error when config transaction decoder is missing', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountInfo = accounts.ConfigTransaction.fromAccountInfo;
    (
      accounts.ConfigTransaction as unknown as {
        fromAccountInfo?: unknown;
      }
    ).fromAccountInfo = undefined;

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readConfigTransaction(
          'solanamainnet',
          5,
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          { data: Buffer.alloc(0) },
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid ConfigTransaction decoder for solanamainnet at index 5: expected fromAccountInfo function, got undefined',
      );
    } finally {
      (
        accounts.ConfigTransaction as unknown as {
          fromAccountInfo: typeof originalFromAccountInfo;
        }
      ).fromAccountInfo = originalFromAccountInfo;
    }
  });

  it('uses fallback addresses when config transaction PDA getters throw', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
        proposalData: Record<string, unknown>,
        accountInfo: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountInfo = accounts.ConfigTransaction.fromAccountInfo;
    (
      accounts.ConfigTransaction as unknown as {
        fromAccountInfo: (...args: unknown[]) => unknown;
      }
    ).fromAccountInfo = () => [{ actions: [] }];
    const hostileProposalData = new Proxy(
      {
        proposal: {},
      },
      {
        get(target, property, receiver) {
          if (property === 'proposalPda' || property === 'multisigPda') {
            throw new Error(`${String(property)} unavailable`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    try {
      const result = await readerAny.readConfigTransaction(
        'solanamainnet',
        5,
        hostileProposalData as unknown as Record<string, unknown>,
        { data: Buffer.alloc(0) },
      );

      expect(result).to.deep.equal({
        chain: 'solanamainnet',
        proposalPda: '[invalid address]',
        transactionIndex: 5,
        multisig: '[invalid address]',
        instructions: [],
      });
    } finally {
      (
        accounts.ConfigTransaction as unknown as {
          fromAccountInfo: typeof originalFromAccountInfo;
        }
      ).fromAccountInfo = originalFromAccountInfo;
    }
  });

  it('throws contextual error when vault transaction loader accessor throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
        proposalData: Record<string, unknown>,
        transactionPda: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      accounts.VaultTransaction,
      'fromAccountAddress',
    );

    Object.defineProperty(accounts.VaultTransaction, 'fromAccountAddress', {
      configurable: true,
      get() {
        throw new Error('vault loader unavailable');
      },
    });

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readVaultTransaction(
          'solanamainnet',
          5,
          { getAccountInfo: async () => null },
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          new PublicKey('11111111111111111111111111111111'),
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read VaultTransaction account loader for solanamainnet: Error: vault loader unavailable',
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          accounts.VaultTransaction,
          'fromAccountAddress',
          originalDescriptor,
        );
      }
    }
  });

  it('throws contextual error when vault transaction loader is missing', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
        proposalData: Record<string, unknown>,
        transactionPda: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountAddress =
      accounts.VaultTransaction.fromAccountAddress;
    (
      accounts.VaultTransaction as unknown as {
        fromAccountAddress?: unknown;
      }
    ).fromAccountAddress = undefined;

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readVaultTransaction(
          'solanamainnet',
          5,
          { getAccountInfo: async () => null },
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          new PublicKey('11111111111111111111111111111111'),
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid VaultTransaction account loader for solanamainnet: expected fromAccountAddress function, got undefined',
      );
    } finally {
      (
        accounts.VaultTransaction as unknown as {
          fromAccountAddress: typeof originalFromAccountAddress;
        }
      ).fromAccountAddress = originalFromAccountAddress;
    }
  });

  it('uses fallback transaction address in vault fetch failures', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
        proposalData: Record<string, unknown>,
        transactionPda: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    const originalFromAccountAddress =
      accounts.VaultTransaction.fromAccountAddress;
    (
      accounts.VaultTransaction as unknown as {
        fromAccountAddress: (...args: unknown[]) => unknown;
      }
    ).fromAccountAddress = async () => {
      throw new Error('vault unavailable');
    };

    try {
      const thrownError = await captureAsyncError(() =>
        readerAny.readVaultTransaction(
          'solanamainnet',
          5,
          { getAccountInfo: async () => null },
          {
            proposal: {},
            proposalPda: new PublicKey('11111111111111111111111111111111'),
            multisigPda: new PublicKey('11111111111111111111111111111111'),
          },
          {
            toBase58: () => {
              throw new Error('transaction pda unavailable');
            },
          },
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to fetch VaultTransaction at [invalid address]: Error: vault unavailable',
      );
    } finally {
      (
        accounts.VaultTransaction as unknown as {
          fromAccountAddress: typeof originalFromAccountAddress;
        }
      ).fromAccountAddress = originalFromAccountAddress;
    }
  });

  it('uses fallback addresses when vault transaction PDAs cannot be stringified', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
        proposalData: Record<string, unknown>,
        transactionPda: unknown,
      ) => Promise<Record<string, unknown>>;
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: unknown,
        svmProvider: unknown,
      ) => Promise<{ instructions: unknown[]; warnings: string[] }>;
    };
    const malformedAddressLike = {
      toBase58: () => {
        throw new Error('address unavailable');
      },
    };
    const originalFromAccountAddress =
      accounts.VaultTransaction.fromAccountAddress;
    (
      accounts.VaultTransaction as unknown as {
        fromAccountAddress: (...args: unknown[]) => unknown;
      }
    ).fromAccountAddress = async () => ({ message: { instructions: [] } });
    readerAny.parseVaultInstructions = async () => ({
      instructions: [],
      warnings: [],
    });

    try {
      const result = await readerAny.readVaultTransaction(
        'solanamainnet',
        5,
        { getAccountInfo: async () => null },
        {
          proposal: {},
          proposalPda: malformedAddressLike,
          multisigPda: malformedAddressLike,
        },
        new PublicKey('11111111111111111111111111111111'),
      );

      expect(result).to.deep.equal({
        chain: 'solanamainnet',
        proposalPda: '[invalid address]',
        transactionIndex: 5,
        multisig: '[invalid address]',
        instructions: [],
      });
    } finally {
      (
        accounts.VaultTransaction as unknown as {
          fromAccountAddress: typeof originalFromAccountAddress;
        }
      ).fromAccountAddress = originalFromAccountAddress;
    }
  });

  it('uses fallback addresses when vault transaction PDA getters throw', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readVaultTransaction: (
        chain: string,
        transactionIndex: number,
        svmProvider: unknown,
        proposalData: Record<string, unknown>,
        transactionPda: unknown,
      ) => Promise<Record<string, unknown>>;
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: unknown,
        svmProvider: unknown,
      ) => Promise<{ instructions: unknown[]; warnings: string[] }>;
    };
    const originalFromAccountAddress =
      accounts.VaultTransaction.fromAccountAddress;
    (
      accounts.VaultTransaction as unknown as {
        fromAccountAddress: (...args: unknown[]) => unknown;
      }
    ).fromAccountAddress = async () => ({ message: { instructions: [] } });
    readerAny.parseVaultInstructions = async () => ({
      instructions: [],
      warnings: [],
    });
    const hostileProposalData = new Proxy(
      {
        proposal: {},
      },
      {
        get(target, property, receiver) {
          if (property === 'proposalPda' || property === 'multisigPda') {
            throw new Error(`${String(property)} unavailable`);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    try {
      const result = await readerAny.readVaultTransaction(
        'solanamainnet',
        5,
        { getAccountInfo: async () => null },
        hostileProposalData as unknown as Record<string, unknown>,
        new PublicKey('11111111111111111111111111111111'),
      );

      expect(result).to.deep.equal({
        chain: 'solanamainnet',
        proposalPda: '[invalid address]',
        transactionIndex: 5,
        multisig: '[invalid address]',
        instructions: [],
      });
    } finally {
      (
        accounts.VaultTransaction as unknown as {
          fromAccountAddress: typeof originalFromAccountAddress;
        }
      ).fromAccountAddress = originalFromAccountAddress;
    }
  });

  it('does not misclassify multisig validator instructions when chain lookup throws during parse', () => {
    const mpp = {
      tryGetChainName: () => {
        throw new Error('chain lookup failed');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readMultisigIsmInstruction: (
        chain: string,
        instructionData: Buffer,
      ) => Record<string, unknown>;
    };
    const validatorHex = `0x${Buffer.from(
      new Uint8Array(20).fill(0x11),
    ).toString('hex')}`;

    const parsedInstruction = readerAny.readMultisigIsmInstruction(
      'solanamainnet',
      createSetValidatorsAndThresholdInstructionData(1000, 0x11),
    );

    expect(parsedInstruction).to.deep.equal({
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: {
        domain: 1000,
        threshold: 1,
        validatorCount: 1,
        validators: [validatorHex],
      },
      insight: 'Set 1 validator(s) with threshold 1 for 1000',
      warnings: [],
    });
  });

  it('does not misclassify multisig validator instructions when chain lookup throws unreadable values', () => {
    const { proxy: revokedChainLookupError, revoke } = Proxy.revocable({}, {});
    revoke();
    const mpp = {
      tryGetChainName: () => {
        throw revokedChainLookupError;
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readMultisigIsmInstruction: (
        chain: string,
        instructionData: Buffer,
      ) => Record<string, unknown>;
    };
    const validatorHex = `0x${Buffer.from(
      new Uint8Array(20).fill(0x11),
    ).toString('hex')}`;

    const parsedInstruction = readerAny.readMultisigIsmInstruction(
      'solanamainnet',
      createSetValidatorsAndThresholdInstructionData(1000, 0x11),
    );

    expect(parsedInstruction).to.deep.equal({
      instructionType:
        SealevelMultisigIsmInstructionName[
          SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD
        ],
      data: {
        domain: 1000,
        threshold: 1,
        validatorCount: 1,
        validators: [validatorHex],
      },
      insight: 'Set 1 validator(s) with threshold 1 for 1000',
      warnings: [],
    });
  });

  it('does not misclassify multisig validator instructions when chain lookup returns malformed aliases', () => {
    let chainLookupCount = 0;
    const mpp = {
      tryGetChainName: () => {
        chainLookupCount += 1;
        return { alias: 'solanatestnet' };
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readMultisigIsmInstruction: (
        chain: string,
        instructionData: Buffer,
      ) => Record<string, unknown>;
    };

    const parsedInstruction = readerAny.readMultisigIsmInstruction(
      'solanamainnet',
      createSetValidatorsAndThresholdInstructionData(1000, 0x22),
    );

    expect(chainLookupCount).to.equal(1);
    expect(parsedInstruction.insight).to.equal(
      'Set 1 validator(s) with threshold 1 for 1000',
    );
    expect((parsedInstruction.data as Record<string, unknown>).error).to.equal(
      undefined,
    );
  });

  it('does not misclassify warp enroll-remote-router instructions when chain lookup throws during parse', () => {
    const mpp = {
      tryGetChainName: () => {
        throw new Error('chain lookup failed');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readWarpRouteInstruction: (
        chain: string,
        instructionData: Buffer,
        metadata: Record<string, string>,
      ) => Record<string, unknown>;
    };
    const router = `0x${Buffer.from(new Uint8Array(32).fill(0xaa)).toString('hex')}`;

    const parsedInstruction = readerAny.readWarpRouteInstruction(
      'solanamainnet',
      createEnrollRemoteRouterInstructionData(1000, 0xaa),
      { symbol: 'TEST', name: 'Test Token', routeName: 'test-route' },
    );

    expect(parsedInstruction).to.deep.equal({
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouter
        ],
      data: {
        domain: 1000,
        chainName: undefined,
        router,
      },
      insight: `Enroll remote router for 1000: ${router}`,
      warnings: [],
    });
  });

  it('does not misclassify warp enroll-remote-routers instructions when chain lookup returns malformed aliases', () => {
    let chainLookupCount = 0;
    const mpp = {
      tryGetChainName: () => {
        chainLookupCount += 1;
        return { alias: 'solanatestnet' };
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readWarpRouteInstruction: (
        chain: string,
        instructionData: Buffer,
        metadata: Record<string, string>,
      ) => Record<string, unknown>;
    };

    const parsedInstruction = readerAny.readWarpRouteInstruction(
      'solanamainnet',
      createEnrollRemoteRoutersInstructionData(1000),
      { symbol: 'TEST', name: 'Test Token', routeName: 'test-route' },
    );

    expect(chainLookupCount).to.equal(1);
    expect(parsedInstruction).to.deep.equal({
      instructionType:
        SealevelHypTokenInstructionName[
          SealevelHypTokenInstruction.EnrollRemoteRouters
        ],
      data: {
        count: 1,
        routers: [{ domain: 1000, chainName: undefined, router: null }],
      },
      insight: 'Enroll 1 remote router(s)',
      warnings: [],
    });
  });

  it('does not misclassify warp destination-gas instructions when chain lookup throws during parse', () => {
    let chainLookupCount = 0;
    const mpp = {
      tryGetChainName: () => {
        chainLookupCount += 1;
        throw new Error('chain lookup failed');
      },
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readWarpRouteInstruction: (
        chain: string,
        instructionData: Buffer,
        metadata: Record<string, string>,
      ) => Record<string, unknown>;
    };

    const parsedInstruction = readerAny.readWarpRouteInstruction(
      'solanamainnet',
      createSetDestinationGasConfigsInstructionData(1000, 5n),
      { symbol: 'TEST', name: 'Test Token', routeName: 'test-route' },
    );

    expect(chainLookupCount).to.equal(1);
    expect(parsedInstruction.instructionType).to.equal(
      SealevelHypTokenInstructionName[
        SealevelHypTokenInstruction.SetDestinationGasConfigs
      ],
    );
    expect(parsedInstruction.insight).to.equal(
      'Set destination gas for 1 chain(s)',
    );
    expect(parsedInstruction.warnings).to.deep.equal([]);
    const parsedConfigs = (
      parsedInstruction.data as { configs: Array<Record<string, unknown>> }
    ).configs as Array<Record<string, unknown>>;
    expect(parsedConfigs).to.have.lengthOf(1);
    expect(parsedConfigs[0].domain).to.equal(1000);
    expect(parsedConfigs[0].chainName).to.equal(undefined);
    expect(String(parsedConfigs[0].gas)).to.equal('5');
  });

  it('keeps mailbox default-ISM instruction classification when pubkey toBase58 throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readMailboxInstruction: (
        chain: string,
        instructionData: Buffer,
      ) => Record<string, unknown>;
    };
    const originalToBase58 = PublicKey.prototype.toBase58;
    PublicKey.prototype.toBase58 = () => {
      throw new Error('pubkey unavailable');
    };

    try {
      const parsedInstruction = readerAny.readMailboxInstruction(
        'solanamainnet',
        createMailboxSetDefaultIsmInstructionData(0xaa),
      );

      expect(parsedInstruction).to.deep.equal({
        instructionType:
          SealevelMailboxInstructionName[
            SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM
          ],
        data: { newDefaultIsm: '[invalid address]' },
        insight: 'Set default ISM to [invalid address]',
        warnings: [],
      });
    } finally {
      PublicKey.prototype.toBase58 = originalToBase58;
    }
  });

  it('keeps multisig transfer-ownership classification when pubkey toBase58 throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readMultisigIsmInstruction: (
        chain: string,
        instructionData: Buffer,
      ) => Record<string, unknown>;
    };
    const originalToBase58 = PublicKey.prototype.toBase58;
    PublicKey.prototype.toBase58 = () => {
      throw new Error('pubkey unavailable');
    };

    try {
      const parsedInstruction = readerAny.readMultisigIsmInstruction(
        'solanamainnet',
        createMultisigTransferOwnershipInstructionData(0xbb),
      );

      expect(parsedInstruction).to.deep.equal({
        instructionType:
          SealevelMultisigIsmInstructionName[
            SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP
          ],
        data: { newOwner: '[invalid address]' },
        insight: 'Transfer ownership to [invalid address]',
        warnings: ['⚠️  OWNERSHIP TRANSFER DETECTED'],
      });
    } finally {
      PublicKey.prototype.toBase58 = originalToBase58;
    }
  });

  it('keeps warp transfer-ownership classification when pubkey toBase58 throws', () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      readWarpRouteInstruction: (
        chain: string,
        instructionData: Buffer,
        metadata: Record<string, string>,
      ) => Record<string, unknown>;
    };
    const originalToBase58 = PublicKey.prototype.toBase58;
    PublicKey.prototype.toBase58 = () => {
      throw new Error('pubkey unavailable');
    };

    try {
      const parsedInstruction = readerAny.readWarpRouteInstruction(
        'solanamainnet',
        createWarpTransferOwnershipInstructionData(0xcc),
        { symbol: 'TEST', name: 'Test Token', routeName: 'test-route' },
      );

      expect(parsedInstruction).to.deep.equal({
        instructionType:
          SealevelHypTokenInstructionName[
            SealevelHypTokenInstruction.TransferOwnership
          ],
        data: { newOwner: '[invalid address]' },
        insight: 'Transfer ownership to [invalid address]',
        warnings: ['⚠️  OWNERSHIP TRANSFER DETECTED'],
      });
    } finally {
      PublicKey.prototype.toBase58 = originalToBase58;
    }
  });

  it('does not require full proposal status shape when index is valid', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'mailbox-program-id',
        multisig_ism_message_id: 'multisig-ism-program-id',
      }),
    });
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () => ({
      proposal: {
        transactionIndex: 5,
        status: 'malformed-status-shape',
        approved: 'not-an-array',
      },
      proposalPda: new PublicKey('11111111111111111111111111111111'),
      multisigPda: new PublicKey('11111111111111111111111111111111'),
      programId: new PublicKey('11111111111111111111111111111111'),
    });
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });
    readerAny.readConfigTransaction = async (_, transactionIndex) => ({
      chain: 'solanamainnet',
      transactionIndex,
    });

    const result = (await reader.read('solanamainnet', 5)) as {
      transactionIndex?: number;
    };

    expect(result.transactionIndex).to.equal(5);
    expect(reader.errors).to.deep.equal([]);
  });

  it('throws stable error when core program resolver accessor throws', async () => {
    const reader = new SquadsTransactionReader(
      createNoopMpp(),
      new Proxy(
        {
          resolveCoreProgramIds: () => ({
            mailbox: SYSTEM_PROGRAM_ID.toBase58(),
            multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
          }),
        },
        {
          get(target, property, receiver) {
            if (property === 'resolveCoreProgramIds') {
              throw new Error('resolver accessor failed');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as {
        resolveCoreProgramIds: (chain: string) => {
          mailbox: string;
          multisig_ism_message_id: string;
        };
      },
    );
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to access core program resolver for solanamainnet: Error: resolver accessor failed',
    );
  });

  it('throws placeholder fallback when core program resolver accessor throws generic-object Error messages', async () => {
    const reader = new SquadsTransactionReader(
      createNoopMpp(),
      new Proxy(
        {
          resolveCoreProgramIds: () => ({
            mailbox: SYSTEM_PROGRAM_ID.toBase58(),
            multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
          }),
        },
        {
          get(target, property, receiver) {
            if (property === 'resolveCoreProgramIds') {
              throw new Error('[object Object]');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as {
        resolveCoreProgramIds: (chain: string) => {
          mailbox: string;
          multisig_ism_message_id: string;
        };
      },
    );
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to access core program resolver for solanamainnet: [unstringifiable error]',
    );
  });

  it('throws stable error when core program resolver returns malformed objects', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        'malformed-core-program-ids' as unknown as {
          mailbox: string;
          multisig_ism_message_id: string;
        },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Invalid core program ids for solanamainnet: expected object, got string',
    );
  });

  it('throws stable error when core program resolver is not callable', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: 1,
    } as unknown as {
      resolveCoreProgramIds: (chain: string) => {
        mailbox: string;
        multisig_ism_message_id: string;
      };
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Invalid core program resolver for solanamainnet: expected function, got number',
    );
  });

  it('throws stable error when core program resolver invocation throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => {
        throw new Error('resolver invocation failed');
      },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to resolve core program ids for solanamainnet: Error: resolver invocation failed',
    );
  });

  it('throws stable error when core program resolver returns promise-like values', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        Promise.resolve({
          mailbox: SYSTEM_PROGRAM_ID.toBase58(),
          multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
        }) as unknown as { mailbox: string; multisig_ism_message_id: string },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Invalid core program ids for solanamainnet: expected synchronous object result, got promise-like value',
    );
  });

  it('throws stable error when promise-like then field access fails', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('then getter failed');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as { mailbox: string; multisig_ism_message_id: string },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect core program ids for solanamainnet: failed to read promise-like then field (Error: then getter failed)',
    );
  });

  it('throws placeholder fallback when core-program-id then field access throws generic-object Error messages', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('[object Object]');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as { mailbox: string; multisig_ism_message_id: string },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect core program ids for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('throws placeholder fallback when core-program-id then field access throws bare Error labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw new Error('Error:');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as { mailbox: string; multisig_ism_message_id: string },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect core program ids for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('throws placeholder fallback when core-program-id then field access throws opaque values', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {},
          {
            get(target, property, receiver) {
              if (property === 'then') {
                throw {};
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as { mailbox: string; multisig_ism_message_id: string },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to inspect core program ids for solanamainnet: failed to read promise-like then field ([unstringifiable error])',
    );
  });

  it('labels unreadable core program id objects deterministically', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => {
        const { proxy: revokedCoreProgramIds, revoke } = Proxy.revocable(
          {},
          {},
        );
        revoke();
        return revokedCoreProgramIds as unknown as {
          mailbox: string;
          multisig_ism_message_id: string;
        };
      },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Invalid core program ids for solanamainnet: expected object, got [unreadable value type]',
    );
  });

  it('throws stable error when mailbox program id getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {
            multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
          },
          {
            get(target, property, receiver) {
              if (property === 'mailbox') {
                throw new Error('mailbox getter failed');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as {
          mailbox: string;
          multisig_ism_message_id: string;
        },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read mailbox program id for solanamainnet: Error: mailbox getter failed',
    );
  });

  it('throws stable error when multisig program id getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () =>
        new Proxy(
          {
            mailbox: SYSTEM_PROGRAM_ID.toBase58(),
          },
          {
            get(target, property, receiver) {
              if (property === 'multisig_ism_message_id') {
                throw new Error('multisig getter failed');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ) as unknown as {
          mailbox: string;
          multisig_ism_message_id: string;
        },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Failed to read multisig_ism_message_id program id for solanamainnet: Error: multisig getter failed',
    );
  });

  it('throws stable error when resolved core program ids are malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: '   ',
        multisig_ism_message_id: 'not-a-public-key',
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Expected mailbox program id for solanamainnet to be a non-empty string, got empty string',
    );
  });

  it('throws stable error when resolved multisig program id is malformed', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: '   ',
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.equal(
      'Expected multisig_ism_message_id program id for solanamainnet to be a non-empty string, got empty string',
    );
  });

  it('throws stable error when resolved mailbox program id is not a valid public key', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: 'not-a-public-key',
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.match(
      /^Invalid mailbox program id for solanamainnet: Error:/,
    );
  });

  it('throws stable error when resolved multisig program id is not a valid public key', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: 'not-a-public-key',
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const thrownError = await captureAsyncError(() =>
      readerAny.parseVaultInstructions(
        'solanamainnet',
        {
          message: {
            accountKeys: [],
            addressTableLookups: [],
            instructions: [],
          },
        },
        { getAccountInfo: async () => null },
      ),
    );

    expect(thrownError?.message).to.match(
      /^Invalid multisig_ism_message_id program id for solanamainnet: Error:/,
    );
  });

  it('uses fallback unknown-program labels when instruction program id toBase58 throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const malformedProgramId = {
      equals: () => false,
      toBase58: () => {
        throw new Error('program id unavailable');
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [malformedProgramId as unknown as PublicKey],
          addressTableLookups: [],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      { getAccountInfo: async () => null },
    );

    expect(parsed.warnings).to.deep.equal([
      '⚠️  UNKNOWN PROGRAM: [invalid program id]',
      'This instruction could not be verified!',
    ]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: malformedProgramId,
        programName: 'Unknown',
        instructionType: 'Unknown',
        data: {
          programId: '[invalid program id]',
          rawData: '010203',
        },
        accounts: [],
        warnings: [
          '⚠️  UNKNOWN PROGRAM: [invalid program id]',
          'This instruction could not be verified!',
        ],
      },
    ]);
  });

  it('uses fallback unknown-program labels when instruction program id toBase58 returns generic object label', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const malformedProgramId = {
      equals: () => false,
      toBase58: () => '[object PublicKey]',
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [malformedProgramId as unknown as PublicKey],
          addressTableLookups: [],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      { getAccountInfo: async () => null },
    );

    expect(parsed.warnings).to.deep.equal([
      '⚠️  UNKNOWN PROGRAM: [invalid program id]',
      'This instruction could not be verified!',
    ]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: malformedProgramId,
        programName: 'Unknown',
        instructionType: 'Unknown',
        data: {
          programId: '[invalid program id]',
          rawData: '010203',
        },
        accounts: [],
        warnings: [
          '⚠️  UNKNOWN PROGRAM: [invalid program id]',
          'This instruction could not be verified!',
        ],
      },
    ]);
  });

  it('does not classify warp routes when program id stringifies to generic object label', async () => {
    const mpp = {
      tryGetProtocol: () => ProtocolType.Sealevel,
    } as unknown as MultiProtocolProvider;
    const reader = new SquadsTransactionReader(mpp, {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    await reader.init({
      routeA: {
        tokens: [
          {
            chainName: 'solanamainnet',
            standard: 'SealevelHypNative',
            addressOrDenom: '[object PublicKey]',
            symbol: 'TEST',
            name: 'Test Token',
            collateralAddressOrDenom: '',
            decimals: 9,
            connections: [],
          },
        ],
      },
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const malformedProgramId = {
      equals: () => false,
      toBase58: () => '[object PublicKey]',
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [malformedProgramId as unknown as PublicKey],
          addressTableLookups: [],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      { getAccountInfo: async () => null },
    );

    expect(parsed.instructions[0]?.programName).to.equal('Unknown');
    expect(parsed.instructions[0]?.instructionType).to.equal('Unknown');
    expect(parsed.warnings).to.deep.equal([
      '⚠️  UNKNOWN PROGRAM: [invalid program id]',
      'This instruction could not be verified!',
    ]);
  });

  it('keeps unknown-program parsing when program-id equals throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const malformedProgramId = {
      equals: () => {
        throw new Error('equals unavailable');
      },
      toBase58: () => 'malformed-program-id',
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [malformedProgramId as unknown as PublicKey],
          addressTableLookups: [],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      { getAccountInfo: async () => null },
    );

    expect(parsed.warnings).to.deep.equal([
      '⚠️  UNKNOWN PROGRAM: malformed-program-id',
      'This instruction could not be verified!',
    ]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: malformedProgramId,
        programName: 'Unknown',
        instructionType: 'Unknown',
        data: {
          programId: 'malformed-program-id',
          rawData: '010203',
        },
        accounts: [],
        warnings: [
          '⚠️  UNKNOWN PROGRAM: malformed-program-id',
          'This instruction could not be verified!',
        ],
      },
    ]);
  });

  it('keeps parsing when lookup-table warning path cannot stringify account keys', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [SYSTEM_PROGRAM_ID],
          addressTableLookups: [
            {
              accountKey: {
                toBase58: () => {
                  throw new Error('lookup key unavailable');
                },
              } as unknown as PublicKey,
              writableIndexes: [],
              readonlyIndexes: [],
            },
          ],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      {
        getAccountInfo: async () => {
          throw new Error('lookup table unavailable');
        },
      },
    );

    expect(parsed.warnings).to.deep.equal([]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
  });

  it('keeps parsing when lookup-table account data getter throws', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [SYSTEM_PROGRAM_ID],
          addressTableLookups: [
            {
              accountKey: SYSTEM_PROGRAM_ID,
              writableIndexes: [],
              readonlyIndexes: [],
            },
          ],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      {
        getAccountInfo: async () =>
          new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'data') {
                  throw new Error('lookup table data unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ),
      },
    );

    expect(parsed.warnings).to.deep.equal([]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
  });

  it('keeps parsing when lookup-table account data type is malformed', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      {
        message: {
          accountKeys: [SYSTEM_PROGRAM_ID],
          addressTableLookups: [
            {
              accountKey: SYSTEM_PROGRAM_ID,
              writableIndexes: [],
              readonlyIndexes: [],
            },
          ],
          instructions: [
            {
              programIdIndex: 0,
              accountIndexes: [],
              data: Buffer.from([1, 2, 3]),
            },
          ],
        },
      },
      {
        getAccountInfo: async () => ({
          data: 7,
        }),
      },
    );

    expect(parsed.warnings).to.deep.equal([]);
    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
  });

  it('keeps parsing when vault account-keys getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: new Proxy(
        { instructions: [] },
        {
          get(target, property, receiver) {
            if (property === 'accountKeys') {
              throw new Error('account keys unavailable');
            }
            if (property === 'addressTableLookups') {
              return [];
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      instructions: [],
      warnings: [],
    });
  });

  it('keeps parsing when vault account-keys iteration throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const hostileAccountKeys = new Proxy([SYSTEM_PROGRAM_ID], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('account key iterator unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const vaultTransaction = {
      message: {
        accountKeys: hostileAccountKeys,
        addressTableLookups: [],
        instructions: [],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      instructions: [],
      warnings: [],
    });
  });

  it('keeps parsing when vault instructions getter throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: new Proxy(
        { accountKeys: [SYSTEM_PROGRAM_ID], addressTableLookups: [] },
        {
          get(target, property, receiver) {
            if (property === 'instructions') {
              throw new Error('instructions unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      instructions: [],
      warnings: [],
    });
  });

  it('keeps parsing when vault instructions iteration throws', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const hostileInstructions = new Proxy([], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('instruction iterator unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: hostileInstructions,
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      instructions: [],
      warnings: [],
    });
  });

  it('keeps system-instruction parsing when account-indexes getter throws', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const hostileInstruction = new Proxy(
      {
        programIdIndex: 0,
        data: Buffer.from([1, 2, 3]),
      },
      {
        get(target, property, receiver) {
          if (property === 'accountIndexes') {
            throw new Error('account indexes unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [hostileInstruction],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      warnings: [],
      instructions: [
        {
          programId: SYSTEM_PROGRAM_ID,
          programName: 'System Program',
          instructionType: 'System Call',
          data: {},
          accounts: [],
          warnings: [],
        },
      ],
    });
  });

  it('keeps system-instruction parsing when instruction-data getter throws', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const hostileInstruction = new Proxy(
      {
        programIdIndex: 0,
        accountIndexes: [],
      },
      {
        get(target, property, receiver) {
          if (property === 'data') {
            throw new Error('instruction data unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [hostileInstruction],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed).to.deep.equal({
      warnings: [],
      instructions: [
        {
          programId: SYSTEM_PROGRAM_ID,
          programName: 'System Program',
          instructionType: 'System Call',
          data: {},
          accounts: [],
          warnings: [],
        },
      ],
    });
  });

  it('records warnings when instruction account-indexes type is malformed', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: 7,
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
    expect(parsed.warnings).to.deep.equal([
      'Malformed instruction account indexes on solanamainnet at 0: expected array, got number',
    ]);
  });

  it('keeps system-instruction parsing when instruction data has malformed type', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: 7,
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
    expect(parsed.warnings).to.deep.equal([
      'Malformed instruction 0 data on solanamainnet: expected bytes, got number',
    ]);
  });

  it('keeps system-instruction parsing when instruction data type inspection is unreadable', async () => {
    const { proxy: revokedInstructionData, revoke } = Proxy.revocable({}, {});
    revoke();
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: revokedInstructionData,
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
    expect(parsed.warnings).to.deep.equal([
      'Malformed instruction 0 data on solanamainnet: expected bytes, got [unreadable value type]',
    ]);
  });

  it('keeps system-instruction parsing when instruction data array cannot normalize', async () => {
    const nonSystemProgramId = new PublicKey(
      new Uint8Array(32).fill(7),
    ).toBase58();
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: nonSystemProgramId,
        multisig_ism_message_id: nonSystemProgramId,
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
    };
    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: [1n],
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction as unknown as Record<string, unknown>,
      { getAccountInfo: async () => null },
    );

    expect(parsed.instructions).to.deep.equal([
      {
        programId: SYSTEM_PROGRAM_ID,
        programName: 'System Program',
        instructionType: 'System Call',
        data: {},
        accounts: [],
        warnings: [],
      },
    ]);
    expect(parsed.warnings).to.have.lengthOf(1);
    expect(parsed.warnings[0]).to.contain(
      'Failed to normalize instruction 0 data on solanamainnet:',
    );
    expect(parsed.warnings[0]).to.contain('BigInt');
  });

  it('formats unstringifiable instruction parse errors safely', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    const unstringifiableError = createUnstringifiableError();
    readerAny.isMailboxInstruction = () => {
      throw unstringifiableError;
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]).to.include({
      instructionType: 'Parse Failed',
      programName: 'Unknown',
    });
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('formats malformed Error instruction parse failures safely', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createErrorWithUnstringifiableMessage();
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]).to.include({
      instructionType: 'Parse Failed',
      programName: 'Unknown',
    });
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('uses placeholder when malformed Error parse failures stringify to generic object labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createErrorWithGenericObjectStringification();
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('uses message from unstringifiable instruction parse throw objects', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createUnstringifiableErrorWithMessage(
        'unable to parse instruction',
      );
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: unable to parse instruction',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'unable to parse instruction',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: unable to parse instruction',
    ]);
  });

  it('prefers stack over message for unstringifiable instruction parse throw objects', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createUnstringifiableErrorWithStackAndMessage(
        'Error: unable to parse instruction\n at parse.ts:1:1',
        'unable to parse instruction',
      );
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: Error: unable to parse instruction\n at parse.ts:1:1',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'Error: unable to parse instruction\n at parse.ts:1:1',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: Error: unable to parse instruction\n at parse.ts:1:1',
    ]);
  });

  it('falls back to message when stack accessor throws during instruction parse failures', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createUnstringifiableErrorWithThrowingStackGetter(
        'unable to parse instruction',
      );
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: unable to parse instruction',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'unable to parse instruction',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: unable to parse instruction',
    ]);
  });

  it('falls back to message when parse-failure object stack is whitespace-only', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw {
        stack: '   ',
        message: 'unable to parse instruction',
        toString() {
          return 'should not be used';
        },
      };
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: unable to parse instruction',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'unable to parse instruction',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: unable to parse instruction',
    ]);
  });

  it('falls back to String(error) when stack/message accessors throw during parse failures', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createStringifiableErrorWithThrowingStackAndMessage(
        'custom parse error',
      );
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: custom parse error',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'custom parse error',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: custom parse error',
    ]);
  });

  it('uses placeholder when parse-failure String(error) normalizes to empty text', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw createStringifiableErrorWithThrowingStackAndMessage('   ');
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('uses placeholder when parse failures throw whitespace-only strings', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw '   ';
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('uses placeholder when parse failures throw bare Error labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw new Error('');
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('uses placeholder when parse failures throw bare TypeError labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw new TypeError('');
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });

  it('preserves custom Error-like parse-failure string labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw 'RpcError';
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: RpcError',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: 'RpcError',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: RpcError',
    ]);
  });

  it('uses placeholder when parse failures stringify to generic object labels', async () => {
    const reader = new SquadsTransactionReader(createNoopMpp(), {
      resolveCoreProgramIds: () => ({
        mailbox: SYSTEM_PROGRAM_ID.toBase58(),
        multisig_ism_message_id: SYSTEM_PROGRAM_ID.toBase58(),
      }),
    });
    const readerAny = reader as unknown as {
      parseVaultInstructions: (
        chain: string,
        vaultTransaction: Record<string, unknown>,
        svmProvider: unknown,
      ) => Promise<{
        instructions: Array<Record<string, unknown>>;
        warnings: string[];
      }>;
      isMailboxInstruction: () => boolean;
    };

    readerAny.isMailboxInstruction = () => {
      throw {};
    };

    const vaultTransaction = {
      message: {
        accountKeys: [SYSTEM_PROGRAM_ID],
        addressTableLookups: [],
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: [],
            data: Buffer.from([1, 2, 3]),
          },
        ],
      },
    };

    const parsed = await readerAny.parseVaultInstructions(
      'solanamainnet',
      vaultTransaction,
      {
        getAccountInfo: async () => null,
      },
    );

    expect(parsed.warnings).to.deep.equal([
      'Failed to parse instruction: Instruction 0: [unstringifiable error]',
    ]);
    expect(parsed.instructions).to.have.lengthOf(1);
    expect(parsed.instructions[0]?.data).to.deep.equal({
      error: '[unstringifiable error]',
    });
    expect(parsed.instructions[0]?.warnings).to.deep.equal([
      'Failed to parse: [unstringifiable error]',
    ]);
  });
});
