import { utils } from 'ethers';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk/ism/utils';
import { assert } from '@hyperlane-xyz/utils';

import type { CcipRequest } from '../http.js';

const SIGNATURE_HEADER_REGEX = /^Hyperlane-Signature (.+)$/;

export const CcsSignerSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const CredentialsSchema = z.object({
  sender: CcsSignerSchema,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
const CommitmentParamsSchema = z.object({
  commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/** Both CCS readers use the existing EIP-191 offchain lookup signature. */
export class CcsAuth {
  private readonly signers: Set<string>;
  private readonly identities = new WeakMap<CcipRequest, string>();

  constructor(
    private readonly baseUrl: string,
    authorizedSigners: string[],
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.signers = new Set(
      authorizedSigners.map((address) =>
        CcsSignerSchema.parse(address).toLowerCase(),
      ),
    );
  }

  signer(request: CcipRequest): string {
    const signer = this.identities.get(request);
    assert(signer, 'Missing authenticated CCS signer');
    return signer;
  }

  authenticate = async (request: CcipRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    let signer: string;
    try {
      // Bind to the configured public URL, never a caller-controlled Host header.
      const isPost = request.method === 'POST';
      const credentials = CredentialsSchema.parse(
        isPost
          ? request.body
          : {
              sender: request.headers['x-hyperlane-sender'],
              data: CommitmentParamsSchema.parse(request.params).commitment,
              signature: request.headers.authorization?.match(
                SIGNATURE_HEADER_REGEX,
              )?.[1],
            },
      );
      signer = utils
        .verifyMessage(
          utils.arrayify(
            offchainLookupRequestMessageHash(
              credentials.sender,
              credentials.data,
              `${this.baseUrl}/${isPost ? 'getCallsFromRevealMessage' : 'calldata'}`,
            ),
          ),
          credentials.signature,
        )
        .toLowerCase();
    } catch {
      request.log.warn('CCS authentication failed');
      return reply
        .code(401)
        .send({ error: 'Invalid or missing CCS authentication' });
    }
    if (!this.signers.has(signer)) {
      request.log.warn({ signer }, 'CCS signer not authorized');
      return reply.code(403).send({ error: 'CCS signer not authorized' });
    }
    this.identities.set(request, signer);
    request.log.setBindings({ ccsSigner: signer });
  };
}
