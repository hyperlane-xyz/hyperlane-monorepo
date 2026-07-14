import { AleoNetworkClient } from '@provablehq/sdk/testnet.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { isArc20ProgramId, isV2WarpToken } from '../utils/helper.js';

import {
  getArc20TokenMetadata,
  localRemoteDecimalsToScale,
  parseAleoUint,
  parseViewFunctionOutputs,
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
