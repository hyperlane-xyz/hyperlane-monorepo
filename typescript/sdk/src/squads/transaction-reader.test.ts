import { expect } from 'chai';
import { serialize } from 'borsh';
import { PublicKey } from '@solana/web3.js';
import { accounts } from '@sqds/multisig';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
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
} from '../ism/serialization.js';
import {
  SealevelMailboxInstructionName,
  SealevelMailboxInstructionType,
} from '../mailbox/serialization.js';
import {
  SealevelEnrollRemoteRouterInstruction,
  SealevelEnrollRemoteRouterInstructionSchema,
  SealevelEnrollRemoteRoutersInstruction,
  SealevelEnrollRemoteRoutersInstructionSchema,
  SealevelGasRouterConfig,
  SealevelHypTokenInstruction,
  SealevelHypTokenInstructionName,
  SealevelRemoteRouterConfig,
  SealevelSetDestinationGasConfigsInstruction,
  SealevelSetDestinationGasConfigsInstructionSchema,
} from '../token/adapters/serialization.js';
import type { WarpCoreConfig } from '../warp/types.js';
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
      } as unknown as WarpCoreConfig,
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
      } as unknown as WarpCoreConfig,
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
    ) as unknown as WarpCoreConfig;

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
      } as unknown as WarpCoreConfig,
    });

    expect(
      reader.warpRouteIndex.get('solanamainnet')?.get('good003'),
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
          malformedToken as unknown as WarpCoreConfig['tokens'][number],
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'GOOD004',
            symbol: 'GOOD',
            name: 'Good Token',
          },
        ],
      } as unknown as WarpCoreConfig,
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

    expect(thrownError?.message).to.equal('provider lookup failed');
    expect(providerLookupChain).to.equal('solanamainnet');
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 0,
        error: 'Error: provider lookup failed',
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
        key: {},
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
