import { expect } from 'chai';
import { ethers } from 'ethers';
import { Logger } from 'pino';
import sinon from 'sinon';

import { CCTPAttestationService } from '../../src/services/CCTPAttestationService.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ATTESTATION_URL = 'https://attestation.example.com';
const MESSAGE_ID = ethers.utils.hexZeroPad('0xaa', 32);
// Deliberately not a realistic base58 signature shape (too short, contains
// underscores) — a real-looking 64-byte-equivalent base58 string is
// indistinguishable from a Solana private key by length alone and trips
// gitleaks' svm-base58-private-key rule. This is only ever used as an
// opaque passthrough string in these tests (see assertions below), so
// nothing depends on it looking like a real signature.
const TX_SIGNATURE = 'fake_solana_tx_signature_for_tests';

const SOLANA_SOURCE_DOMAIN = 5;
const CCTP_VERSION_2 = 1n;

function makeLogger(): Logger {
  return {
    info: sinon.stub(),
    error: sinon.stub(),
  } as unknown as Logger;
}

function stubFetchJson(body: unknown, status = 200) {
  return sinon.stub(global, 'fetch').resolves({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status',
    json: async () => body,
  } as Response);
}

/** Asserts `promise` rejects with an error whose message matches `pattern`. */
async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: Error | undefined;
  try {
    await promise;
  } catch (err) {
    caught = err as Error;
  }
  expect(caught, 'Expected promise to reject, but it resolved').to.exist;
  expect(caught!.message).to.match(pattern);
}

describe('CCTPAttestationService', () => {
  let service: CCTPAttestationService;

  beforeEach(() => {
    service = new CCTPAttestationService('test-service', ATTESTATION_URL);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Sealevel origin (no cctpMessage bytes available)', () => {
    it('queries Circle by the statically-known sourceDomain/version and returns the sole message', async () => {
      const fetchStub = stubFetchJson({
        messages: [{ message: '0xdeadbeef', attestation: '0xattestation' }],
      });

      const [message, attestation] = await service.getAttestation(
        TX_SIGNATURE,
        MESSAGE_ID,
        makeLogger(),
        { sourceDomain: SOLANA_SOURCE_DOMAIN, version: CCTP_VERSION_2 },
      );

      expect(message).to.equal('0xdeadbeef');
      expect(attestation).to.equal('0xattestation');
      const url = fetchStub.firstCall.args[0] as string;
      expect(url).to.equal(
        `${ATTESTATION_URL}/v2/messages/${SOLANA_SOURCE_DOMAIN}?transactionHash=${TX_SIGNATURE}`,
      );
    });

    it('throws rather than guessing when Circle returns multiple messages for the tx', async () => {
      stubFetchJson({
        messages: [
          { message: '0xaaaa', attestation: '0xattestation1' },
          { message: '0xbbbb', attestation: '0xattestation2' },
        ],
      });

      await expectRejection(
        service.getAttestation(TX_SIGNATURE, MESSAGE_ID, makeLogger(), {
          sourceDomain: SOLANA_SOURCE_DOMAIN,
          version: CCTP_VERSION_2,
        }),
        /Cannot disambiguate/,
      );
    });

    it('throws when the attestation is still pending', async () => {
      stubFetchJson({
        messages: [{ message: null, attestation: null }],
      });

      await expectRejection(
        service.getAttestation(TX_SIGNATURE, MESSAGE_ID, makeLogger(), {
          sourceDomain: SOLANA_SOURCE_DOMAIN,
          version: CCTP_VERSION_2,
        }),
        /pending/,
      );
    });
  });

  describe('EVM origin (cctpMessage bytes available)', () => {
    it('derives sourceDomain/version from the message bytes and disambiguates by byte match', async () => {
      // version(4) + sourceDomain(4) header prefix, matching CctpMessageV2 layout.
      const header = ethers.utils.hexlify(
        ethers.utils.concat([
          ethers.utils.zeroPad(ethers.utils.hexlify(1), 4), // version = CCTP_VERSION_2
          ethers.utils.zeroPad(ethers.utils.hexlify(0), 4), // sourceDomain = 0 (ethereum)
        ]),
      );
      const cctpMessage = ethers.utils.hexlify(
        ethers.utils.concat([header, ethers.utils.randomBytes(140)]),
      );

      const fetchStub = stubFetchJson({
        messages: [{ message: cctpMessage, attestation: '0xattestation' }],
      });

      const [message, attestation] = await service.getAttestation(
        '0xtxhash',
        MESSAGE_ID,
        makeLogger(),
        { cctpMessage },
      );

      expect(message).to.equal(cctpMessage);
      expect(attestation).to.equal('0xattestation');
      const url = fetchStub.firstCall.args[0] as string;
      expect(url).to.equal(
        `${ATTESTATION_URL}/v2/messages/0?transactionHash=0xtxhash`,
      );
    });
  });
});
