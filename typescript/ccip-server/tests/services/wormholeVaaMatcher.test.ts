import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  LOG_MESSAGE_PUBLISHED_ABI,
  WORMHOLE_PAYLOAD_LENGTH,
  WORMHOLE_PAYLOAD_MAGIC,
  WORMHOLE_PAYLOAD_VERSION,
  assertVaaMatchesPublication,
  decodeWormholePayload,
  encodeWormholePayload,
  findMatchingWormholePublication,
  formatVaaId,
  parseVaa,
} from '../../src/services/wormholeVaaMatcher.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CORE = '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B';
const ORIGIN_ROUTER = '0x1111111111111111111111111111111111111111';
const DESTINATION_ROUTER = '0x2222222222222222222222222222222222222222';
const MESSAGE_ID = ethers.utils.id('message');
const ORIGIN_DOMAIN = 1;
const DESTINATION_DOMAIN = 8453;
const NONCE = 7;
const EMITTER_CHAIN_ID = 2;
const SEQUENCE = '42';
const CONSISTENCY_LEVEL = 15;

const iface = new ethers.utils.Interface(LOG_MESSAGE_PUBLISHED_ABI);

function bytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

function payload(
  overrides: Partial<Parameters<typeof encodeWormholePayload>[0]> = {},
) {
  return encodeWormholePayload({
    magic: WORMHOLE_PAYLOAD_MAGIC,
    version: WORMHOLE_PAYLOAD_VERSION,
    originDomain: ORIGIN_DOMAIN,
    destinationDomain: DESTINATION_DOMAIN,
    destinationRouter: bytes32(DESTINATION_ROUTER),
    messageId: MESSAGE_ID,
    nonce: NONCE,
    ...overrides,
  });
}

function publicationLog(
  overrides: {
    address?: string;
    sender?: string;
    sequence?: string;
    nonce?: number;
    payload?: string;
    consistencyLevel?: number;
  } = {},
) {
  const encoded = iface.encodeEventLog(iface.getEvent('LogMessagePublished'), [
    overrides.sender ?? ORIGIN_ROUTER,
    overrides.sequence ?? SEQUENCE,
    overrides.nonce ?? NONCE,
    overrides.payload ?? payload(),
    overrides.consistencyLevel ?? CONSISTENCY_LEVEL,
  ]);
  return {
    address: overrides.address ?? CORE,
    topics: encoded.topics,
    data: encoded.data,
  };
}

const QUERY = {
  coreAddress: CORE,
  originRouter: bytes32(ORIGIN_ROUTER),
  destinationRouter: bytes32(DESTINATION_ROUTER),
  messageId: MESSAGE_ID,
  originDomain: ORIGIN_DOMAIN,
  destinationDomain: DESTINATION_DOMAIN,
  nonce: NONCE,
};

/** Builds a v1 VAA with `signatureCount` unverifiable placeholder signatures. */
function encodeVaa(
  overrides: {
    guardianSetIndex?: number;
    signatureCount?: number;
    timestamp?: number;
    nonce?: number;
    emitterChainId?: number;
    emitterAddress?: string;
    sequence?: string;
    consistencyLevel?: number;
    payload?: string;
  } = {},
): string {
  const signatureCount = overrides.signatureCount ?? 13;
  const signatures = ethers.utils.hexlify(
    new Uint8Array(signatureCount * 66).fill(0xab),
  );
  const body = ethers.utils.solidityPack(
    ['uint32', 'uint32', 'uint16', 'bytes32', 'uint64', 'uint8', 'bytes'],
    [
      overrides.timestamp ?? 1_700_000_000,
      overrides.nonce ?? NONCE,
      overrides.emitterChainId ?? EMITTER_CHAIN_ID,
      overrides.emitterAddress ?? bytes32(ORIGIN_ROUTER),
      overrides.sequence ?? SEQUENCE,
      overrides.consistencyLevel ?? CONSISTENCY_LEVEL,
      overrides.payload ?? payload(),
    ],
  );
  return ethers.utils.hexConcat([
    ethers.utils.solidityPack(
      ['uint8', 'uint32', 'uint8'],
      [1, overrides.guardianSetIndex ?? 4, signatureCount],
    ),
    signatures,
    body,
  ]);
}

// ─── Payload ─────────────────────────────────────────────────────────────────

describe('wormholeVaaMatcher payload', () => {
  it('round-trips the fixed 224-byte envelope', () => {
    const encoded = payload();

    expect(ethers.utils.hexDataLength(encoded)).to.equal(
      WORMHOLE_PAYLOAD_LENGTH,
    );

    const decoded = decodeWormholePayload(encoded);

    expect(decoded.originDomain).to.equal(ORIGIN_DOMAIN);
    expect(decoded.destinationDomain).to.equal(DESTINATION_DOMAIN);
    expect(decoded.destinationRouter).to.equal(bytes32(DESTINATION_ROUTER));
    expect(decoded.messageId).to.equal(MESSAGE_ID);
    expect(decoded.nonce).to.equal(NONCE);
  });

  it('rejects a wrong magic', () => {
    const encoded = payload({ magic: '0xdeadbeef' });

    expect(() => decodeWormholePayload(encoded)).to.throw('magic mismatch');
  });

  it('rejects an unsupported version', () => {
    const encoded = payload({ version: 2 });

    expect(() => decodeWormholePayload(encoded)).to.throw(
      'Unsupported Wormhole payload version',
    );
  });

  it('rejects a payload of the wrong length', () => {
    expect(() => decodeWormholePayload('0xdeadbeef')).to.throw(
      'must be 224 bytes',
    );
  });
});

// ─── Receipt disambiguation ──────────────────────────────────────────────────

describe('findMatchingWormholePublication', () => {
  it('finds the single matching publication', () => {
    const match = findMatchingWormholePublication([publicationLog()], QUERY);

    expect(match.sequence).to.equal(SEQUENCE);
    expect(match.nonce).to.equal(NONCE);
    expect(match.consistencyLevel).to.equal(CONSISTENCY_LEVEL);
    expect(match.payloadFields.messageId).to.equal(MESSAGE_ID);
  });

  it('throws when the receipt has no publication', () => {
    expect(() => findMatchingWormholePublication([], QUERY)).to.throw(
      'No Wormhole publication',
    );
  });

  it('ignores a lookalike event from a non-Core address', () => {
    const impostor = publicationLog({
      address: '0x3333333333333333333333333333333333333333',
    });

    expect(() => findMatchingWormholePublication([impostor], QUERY)).to.throw(
      'No Wormhole publication',
    );
  });

  it('ignores a publication from another emitter on Core', () => {
    const other = publicationLog({
      sender: '0x4444444444444444444444444444444444444444',
    });

    expect(() => findMatchingWormholePublication([other], QUERY)).to.throw(
      'No Wormhole publication',
    );
  });

  it('ignores a Core publication whose payload is not a Hyperlane envelope', () => {
    const unrelated = publicationLog({ payload: '0x1234' });

    expect(() => findMatchingWormholePublication([unrelated], QUERY)).to.throw(
      'No Wormhole publication',
    );
  });

  it('disambiguates several publications by message ID', () => {
    const other = publicationLog({
      sequence: '41',
      payload: payload({ messageId: ethers.utils.id('other') }),
    });

    const match = findMatchingWormholePublication(
      [other, publicationLog()],
      QUERY,
    );

    expect(match.sequence).to.equal(SEQUENCE);
  });

  it('rejects a receipt with two publications for the same message', () => {
    expect(() =>
      findMatchingWormholePublication(
        [publicationLog(), publicationLog({ sequence: '43' })],
        QUERY,
      ),
    ).to.throw('Ambiguous receipt');
  });

  it('rejects a publication bound to another destination router', () => {
    const wrongRouter = publicationLog({
      payload: payload({
        destinationRouter: bytes32(
          '0x5555555555555555555555555555555555555555',
        ),
      }),
    });

    expect(() =>
      findMatchingWormholePublication([wrongRouter], QUERY),
    ).to.throw('No Wormhole publication');
  });
});

// ─── VAA parsing ─────────────────────────────────────────────────────────────

describe('parseVaa', () => {
  it('parses a realistic 13-signature VAA', () => {
    const parsed = parseVaa(encodeVaa());

    expect(parsed.version).to.equal(1);
    expect(parsed.guardianSetIndex).to.equal(4);
    expect(parsed.signatureCount).to.equal(13);
    expect(parsed.emitterChainId).to.equal(EMITTER_CHAIN_ID);
    expect(parsed.emitterAddress).to.equal(bytes32(ORIGIN_ROUTER));
    expect(parsed.sequence).to.equal(SEQUENCE);
    expect(parsed.consistencyLevel).to.equal(CONSISTENCY_LEVEL);
    expect(parsed.nonce).to.equal(NONCE);
    expect(parsed.payload).to.equal(payload());
  });

  it('rejects an unsupported VAA version', () => {
    const vaa = encodeVaa();
    const mutated = ethers.utils.hexConcat([
      '0x02',
      ethers.utils.hexDataSlice(vaa, 1),
    ]);

    expect(() => parseVaa(mutated)).to.throw('Unsupported VAA version');
  });

  it('rejects a truncated VAA', () => {
    const vaa = encodeVaa();
    const truncated = ethers.utils.hexDataSlice(vaa, 0, 40);

    expect(() => parseVaa(truncated)).to.throw('truncated');
  });
});

// ─── Upstream response validation ────────────────────────────────────────────

describe('assertVaaMatchesPublication', () => {
  const publication = () =>
    findMatchingWormholePublication([publicationLog()], QUERY);
  const expected = {
    emitterChainId: EMITTER_CHAIN_ID,
    originRouter: bytes32(ORIGIN_ROUTER),
  };

  it('accepts a VAA that matches the publication', () => {
    assertVaaMatchesPublication(parseVaa(encodeVaa()), publication(), expected);
  });

  it('rejects a VAA from another emitter chain', () => {
    const vaa = parseVaa(encodeVaa({ emitterChainId: 30 }));

    expect(() =>
      assertVaaMatchesPublication(vaa, publication(), expected),
    ).to.throw('does not match origin');
  });

  it('rejects a VAA from another emitter address', () => {
    const vaa = parseVaa(
      encodeVaa({
        emitterAddress: bytes32('0x6666666666666666666666666666666666666666'),
      }),
    );

    expect(() =>
      assertVaaMatchesPublication(vaa, publication(), expected),
    ).to.throw('not the enrolled origin router');
  });

  it('rejects a VAA for another sequence', () => {
    const vaa = parseVaa(encodeVaa({ sequence: '43' }));

    expect(() =>
      assertVaaMatchesPublication(vaa, publication(), expected),
    ).to.throw('does not match publication');
  });

  it('rejects a VAA whose consistency level was downgraded', () => {
    const vaa = parseVaa(encodeVaa({ consistencyLevel: 1 }));

    expect(() =>
      assertVaaMatchesPublication(vaa, publication(), expected),
    ).to.throw('consistency level');
  });

  it('rejects a VAA carrying a different payload', () => {
    const vaa = parseVaa(
      encodeVaa({ payload: payload({ messageId: ethers.utils.id('other') }) }),
    );

    expect(() =>
      assertVaaMatchesPublication(vaa, publication(), expected),
    ).to.throw('payload does not match');
  });
});

describe('formatVaaId', () => {
  it('formats the canonical VAA locator', () => {
    expect(
      formatVaaId(EMITTER_CHAIN_ID, bytes32(ORIGIN_ROUTER), SEQUENCE),
    ).to.equal(`2/${bytes32(ORIGIN_ROUTER).slice(2)}/42`);
  });

  it('normalizes checksummed emitter addresses', () => {
    const emitterAddress =
      '0x' + '00'.repeat(12) + '34084eAEbe9Cbc209A85FFe22fa387223CDFB3e8';
    expect(formatVaaId(EMITTER_CHAIN_ID, emitterAddress, SEQUENCE)).to.equal(
      `2/${emitterAddress.slice(2).toLowerCase()}/42`,
    );
  });
});
