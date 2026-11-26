import { utils } from 'ethers';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  offchainLookupRequestHash,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk/ism/utils';
import { assert } from '@hyperlane-xyz/utils';

import type { CcipRequest } from '../http.js';

const TRAILING_SLASH_REGEX = /\/$/;

/** Path of the CCS reveal lookup, relative to the service prefix. */
export const CCS_REVEAL_PATH = '/getCallsFromRevealMessage' as const;

const SIGNATURE_HEADER_REGEX = /^Hyperlane-Signature (.+)$/i;

const HEX_BYTES_REGEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const NON_EMPTY_HEX_BYTES_REGEX = /^0x(?:[0-9a-fA-F]{2})+$/;

/** How far ahead of the server clock a v2 `issued_at` may be. */
const CCS_AUTH_MAX_CLOCK_SKEW_SECONDS = 5;

/**
 * Lower bound of the configurable v2 signature max age. The Rust relayer
 * reuses a signature for up to 5 seconds, so a shorter max age would refuse
 * its retries; the rest leaves room for transit and clock drift.
 */
export const CCS_AUTH_MAX_AGE_SECONDS_MIN = 10;

/** Upper bound of the configurable v2 signature max age. */
export const CCS_AUTH_MAX_AGE_SECONDS_LIMIT = 120;

export const CcsSignerSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const CredentialsSchema = z.object({
  sender: CcsSignerSchema,
  data: z.string().regex(HEX_BYTES_REGEX),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
const V2CredentialsSchema = CredentialsSchema.extend({
  message_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  issued_at: z.number().int().nonnegative(),
  origin_tx_hash: z.string().regex(NON_EMPTY_HEX_BYTES_REGEX),
});
const CommitmentParamsSchema = z.object({
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

interface CcsIdentity {
  signer: string;
  /** Lowercased message id covered by a POST (v2) signature; absent for GET. */
  messageId?: string;
  /** Origin transaction hash covered by a POST (v2) signature; absent for GET. */
  originTxHash?: string;
}

/**
 * The POST reveal reader accepts only the framed (v2) EIP-191 offchain lookup
 * signature. The GET calldata reader accepts the packed (v1) one in headers.
 */
export class CcsAuth {
  private readonly signers: Set<string>;
  private readonly identities = new WeakMap<CcipRequest, CcsIdentity>();

  constructor(
    private readonly baseUrl: string,
    authorizedSigners: string[],
    private readonly maxAgeSeconds: number,
  ) {
    assert(
      Number.isSafeInteger(maxAgeSeconds) &&
        maxAgeSeconds >= CCS_AUTH_MAX_AGE_SECONDS_MIN &&
        maxAgeSeconds <= CCS_AUTH_MAX_AGE_SECONDS_LIMIT,
      `CCS authentication max age must be an integer from ${CCS_AUTH_MAX_AGE_SECONDS_MIN} to ${CCS_AUTH_MAX_AGE_SECONDS_LIMIT}`,
    );
    this.baseUrl = baseUrl.replace(TRAILING_SLASH_REGEX, '');
    this.signers = new Set(
      authorizedSigners.map((address) =>
        CcsSignerSchema.parse(address).toLowerCase(),
      ),
    );
  }

  signer(request: CcipRequest): string {
    const identity = this.identities.get(request);
    assert(identity, 'Missing authenticated CCS signer');
    return identity.signer;
  }

  /** The lowercased message id covered by a POST (v2) signature. */
  messageId(request: CcipRequest): string {
    const messageId = this.identities.get(request)?.messageId;
    assert(messageId, 'Missing authenticated CCS message id');
    return messageId;
  }

  /** The origin transaction hash covered by a POST (v2) signature. */
  originTxHash(request: CcipRequest): string {
    const originTxHash = this.identities.get(request)?.originTxHash;
    assert(originTxHash, 'Missing authenticated CCS origin transaction hash');
    return originTxHash;
  }

  private verifyV2(body: unknown): CcsIdentity {
    const credentials = V2CredentialsSchema.parse(body);
    const now = Math.floor(Date.now() / 1000);
    assert(
      credentials.issued_at >= now - this.maxAgeSeconds &&
        credentials.issued_at <= now + CCS_AUTH_MAX_CLOCK_SKEW_SECONDS,
      'CCS signature is not fresh',
    );
    const signer = utils
      .verifyMessage(
        utils.arrayify(
          offchainLookupRequestHash({
            urlTemplate: `${this.baseUrl}${CCS_REVEAL_PATH}`,
            sender: credentials.sender,
            callData: credentials.data,
            messageId: credentials.message_id,
            originTxHash: credentials.origin_tx_hash,
            issuedAt: credentials.issued_at,
          }),
        ),
        credentials.signature,
      )
      .toLowerCase();
    return {
      signer,
      messageId: credentials.message_id.toLowerCase(),
      originTxHash: credentials.origin_tx_hash,
    };
  }

  authenticate = async (request: CcipRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    let identity: CcsIdentity;
    try {
      // Bind to the configured public URL, never a caller-controlled Host header.
      identity =
        request.method === 'POST'
          ? this.verifyV2(request.body)
          : this.verifyV1(request);
    } catch {
      request.log.warn('CCS authentication failed');
      return reply
        .code(401)
        .send({ error: 'Invalid or missing CCS authentication' });
    }
    const { signer } = identity;
    if (!this.signers.has(signer)) {
      request.log.warn({ signer }, 'CCS signer not authorized');
      return reply.code(403).send({ error: 'CCS signer not authorized' });
    }
    this.identities.set(request, identity);
    request.log.setBindings({ ccsSigner: signer });
  };

  private verifyV1(request: CcipRequest): CcsIdentity {
    const credentials = CredentialsSchema.parse({
      sender: request.headers['x-hyperlane-sender'],
      data: CommitmentParamsSchema.parse(request.params).commitment,
      signature: request.headers.authorization?.match(
        SIGNATURE_HEADER_REGEX,
      )?.[1],
    });
    const signer = utils
      .verifyMessage(
        utils.arrayify(
          offchainLookupRequestMessageHash(
            credentials.sender,
            credentials.data,
            `${this.baseUrl}/calldata`,
          ),
        ),
        credentials.signature,
      )
      .toLowerCase();
    assert(
      credentials.sender.toLowerCase() === signer,
      'GET sender must match signer',
    );
    return { signer };
  }
}
