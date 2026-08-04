import { AleoNetworkClient } from '@provablehq/sdk/testnet.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import {
  isArc20ProgramId,
  isV2WarpToken,
  stringToU128,
} from '../utils/helper.js';

import {
  TokenRegistryEntryNotFoundError,
  getArc20TokenMetadata,
  localRemoteDecimalsToScale,
  nativeScaleExponentToMultiplier,
  parseAleoUint,
  parseViewFunctionOutputs,
  resolveTokenMetadata,
} from './warp-query.js';

chai.use(chaiAsPromised);

describe('parseAleoUint', () => {
  it('parses a raw Aleo uint literal to a bigint', () => {
    expect(parseAleoUint('1000000u128')).to.equal(1000000n);
    expect(parseAleoUint('6u8')).to.equal(6n);
  });

  it('throws on a non-numeric literal', () => {
    expect(() => parseAleoUint('not-a-number')).to.throw();
  });
});

describe('localRemoteDecimalsToScale', () => {
  it('returns undefined when local and remote decimals match (no scaling)', () => {
    expect(localRemoteDecimalsToScale(6, 6)).to.equal(undefined);
  });

  it('returns undefined when either side is unavailable', () => {
    expect(localRemoteDecimalsToScale(undefined, 18)).to.equal(undefined);
    expect(localRemoteDecimalsToScale(6, undefined)).to.equal(undefined);
  });

  it('scales up when remote decimals exceed local decimals', () => {
    expect(localRemoteDecimalsToScale(6, 18)).to.equal(1_000_000_000_000);
  });

  it('scales down when remote decimals are fewer than local decimals', () => {
    expect(localRemoteDecimalsToScale(18, 6)).to.equal(1e-12);
  });
});

describe('nativeScaleExponentToMultiplier', () => {
  it('returns undefined for an identity exponent (0)', () => {
    expect(nativeScaleExponentToMultiplier(0)).to.equal(undefined);
  });

  it('returns undefined when the exponent is unavailable', () => {
    expect(nativeScaleExponentToMultiplier(undefined)).to.equal(undefined);
  });

  it('converts a positive exponent to the equivalent power-of-10 multiplier', () => {
    expect(nativeScaleExponentToMultiplier(6)).to.equal(1_000_000);
  });
});

describe('parseViewFunctionOutputs', () => {
  it('returns the first output when the shape is a non-empty string array', () => {
    expect(parseViewFunctionOutputs(['6u8'], 'foo.aleo', 'decimals')).to.equal(
      '6u8',
    );
  });

  it('throws when the response is not an array', () => {
    expect(() =>
      parseViewFunctionOutputs({ foo: 'bar' }, 'foo.aleo', 'decimals'),
    ).to.throw();
  });

  it('throws when the array is empty', () => {
    expect(() =>
      parseViewFunctionOutputs([], 'foo.aleo', 'decimals'),
    ).to.throw();
  });

  it('throws when the first element is not a string', () => {
    expect(() =>
      parseViewFunctionOutputs([123], 'foo.aleo', 'decimals'),
    ).to.throw();
  });
});

describe('isV2WarpToken / isArc20ProgramId', () => {
  it('detects v2 warp token program ids by suffix', () => {
    expect(isV2WarpToken('hyp_warp_token_usdc_v2.aleo')).to.equal(true);
    expect(isV2WarpToken('hyp_warp_token_usdc.aleo')).to.equal(false);
  });

  it('detects arc20 program ids', () => {
    expect(isArc20ProgramId('test_arc20_usdc.aleo')).to.equal(true);
    expect(isArc20ProgramId('not-a-program-id')).to.equal(false);
  });
});

describe('getArc20TokenMetadata', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubViewFunctionResponses(outputsByView: Record<string, string>) {
    globalThis.fetch = (async (url: string) => {
      const viewName = url.split('/').pop() ?? '';
      const output = outputsByView[viewName];
      return {
        ok: output !== undefined,
        status: output !== undefined ? 200 : 404,
        json: async () => [output],
      } as Response;
    }) as typeof fetch;
  }

  it('parses name, symbol, and decimals from view function responses', async () => {
    stubViewFunctionResponses({
      name: "'USDC'",
      symbol: "'USDC'",
      decimals: '6u8',
    });

    const aleoClient = new AleoNetworkClient('http://localhost:3030');
    const metadata = await getArc20TokenMetadata(
      aleoClient,
      'test_arc20_usdc.aleo',
    );

    expect(metadata).to.deep.equal({
      name: 'USDC',
      symbol: 'USDC',
      decimals: 6,
    });
  });

  it('throws if the decimals view returns a non-numeric value', async () => {
    stubViewFunctionResponses({
      name: "'USDC'",
      symbol: "'USDC'",
      decimals: "'not-a-number'",
    });

    const aleoClient = new AleoNetworkClient('http://localhost:3030');
    await expect(getArc20TokenMetadata(aleoClient, 'test_arc20_usdc.aleo')).to
      .be.rejected;
  });
});

describe('resolveTokenMetadata', () => {
  const V1_PROGRAM_ID = 'hyp_warp_token_usad.aleo';
  const V2_PROGRAM_ID = 'hyp_warp_token_usdc_v2.aleo';
  const TOKEN_ID = '123field';

  // Keep the bounded-retry behaviour under test but collapse the exponential
  // backoff to zero so miss/exhaustion paths don't take ~51s in the suite.
  const RETRY_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 0;

  // A token_registry.aleo `registered_tokens` TokenMetadata value only needs the
  // name/symbol/decimals fields that getTokenMetadata actually reads.
  function registeredTokenPlaintext(
    name: string,
    symbol: string,
    decimals: number,
  ): string {
    return `{\n  name: ${stringToU128(name)}u128,\n  symbol: ${stringToU128(symbol)}u128,\n  decimals: ${decimals}u8\n}`;
  }

  function clientWithMappingValue(value: string): AleoNetworkClient {
    const client = new AleoNetworkClient('http://localhost:3030');
    client.getProgramMappingValue = async () => value;
    return client;
  }

  it('falls back to local_decimals with empty name/symbol when a v1 miss persists across retries', async () => {
    // An empty mapping value that survives the bounded retries is a genuine
    // registry miss; getTokenMetadata rethrows the sentinel, which
    // resolveTokenMetadata tolerates.
    const aleoClient = clientWithMappingValue('');

    const metadata = await resolveTokenMetadata(
      aleoClient,
      V1_PROGRAM_ID,
      TOKEN_ID,
      9,
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    expect(metadata).to.deep.equal({ name: '', symbol: '', decimals: 9 });
  });

  it('retries a transient empty mapping and prefers registry metadata once it appears', async () => {
    // A just-registered mapping can read empty before it finalizes/indexes.
    // The bounded retry must ride that out and use the authoritative metadata
    // rather than immediately taking the empty-name/symbol legacy fallback.
    let call = 0;
    const aleoClient = new AleoNetworkClient('http://localhost:3030');
    aleoClient.getProgramMappingValue = async () => {
      call += 1;
      return call === 1 ? '' : registeredTokenPlaintext('LATE', 'LATE', 7);
    };

    const metadata = await resolveTokenMetadata(
      aleoClient,
      V1_PROGRAM_ID,
      TOKEN_ID,
      9,
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    expect(call).to.be.greaterThan(1);
    expect(metadata).to.deep.equal({
      name: 'LATE',
      symbol: 'LATE',
      decimals: 7,
    });
  });

  it('prefers registry metadata over local_decimals when the v1 entry exists', async () => {
    const aleoClient = clientWithMappingValue(
      registeredTokenPlaintext('MYTKN', 'MYT', 8),
    );

    const metadata = await resolveTokenMetadata(
      aleoClient,
      V1_PROGRAM_ID,
      TOKEN_ID,
      9,
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );

    expect(metadata).to.deep.equal({
      name: 'MYTKN',
      symbol: 'MYT',
      decimals: 8,
    });
  });

  it('throws when the v1 entry is missing and local_decimals is also unavailable', async () => {
    const aleoClient = clientWithMappingValue('');

    await expect(
      resolveTokenMetadata(
        aleoClient,
        V1_PROGRAM_ID,
        TOKEN_ID,
        undefined,
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS,
      ),
    ).to.be.rejectedWith(/Unable to resolve decimals/);
  });

  it('propagates non-sentinel v1 read failures (transport) instead of masking them', async () => {
    const aleoClient = new AleoNetworkClient('http://localhost:3030');
    // A transport error is retried (recoverable) then propagates; the point
    // under test is that it is not swallowed by resolveTokenMetadata as a miss.
    aleoClient.getProgramMappingValue = async () => {
      throw new Error('RPC transport error');
    };

    const result = resolveTokenMetadata(
      aleoClient,
      V1_PROGRAM_ID,
      TOKEN_ID,
      9,
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );
    await expect(result).to.be.rejectedWith('RPC transport error');
    // The sentinel is the only tolerated failure; a transport error is not it.
    await result.catch((err) => {
      expect(err).to.not.be.instanceOf(TokenRegistryEntryNotFoundError);
    });
  });

  it('propagates v1 decode failures (unparseable registry value) instead of masking them', async () => {
    const aleoClient = clientWithMappingValue('not-a-valid-plaintext');

    await expect(
      resolveTokenMetadata(
        aleoClient,
        V1_PROGRAM_ID,
        TOKEN_ID,
        9,
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS,
      ),
    ).to.be.rejected;
  });

  it('propagates v2 ARC-20 read failures instead of falling back', async () => {
    const aleoClient = new AleoNetworkClient('http://localhost:3030');
    // No arc20 import present, so getArc20ProgramId cannot resolve the token
    // program and throws — v2 has no fallback path.
    aleoClient.getProgramImportNames = async () => [
      'credits.aleo',
      'mailbox.aleo',
    ];

    await expect(
      resolveTokenMetadata(
        aleoClient,
        V2_PROGRAM_ID,
        TOKEN_ID,
        6,
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS,
      ),
    ).to.be.rejected;
  });
});
