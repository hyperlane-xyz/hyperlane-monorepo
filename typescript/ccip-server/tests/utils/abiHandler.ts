import { utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';

import { CctpService__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { type CcipApp, MAX_CCIP_PARAMETER_LENGTH } from '../../src/http.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../../src/utils/abiHandler.js';

export function captureLogger(level = 'info') {
  const lines: string[] = [];
  const logger = pino(
    { level },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

/** Posts a CCIP-read request to an ABI handler whose service rejects with `error`. */
export async function respondWithAbiError(error: Error, level = 'info') {
  const { logger, lines } = captureLogger(level);
  const app: CcipApp = Fastify({
    loggerInstance: logger,
    routerOptions: { maxParamLength: MAX_CCIP_PARAMETER_LENGTH },
  });
  app.post<AbiRoute>(
    '/',
    ABI_ROUTE_OPTIONS,
    createAbiHandler(CctpService__factory, 'getCCTPAttestation', () =>
      Promise.reject(error),
    ),
  );
  await app.ready();
  try {
    const data = CctpService__factory.createInterface().encodeFunctionData(
      'getCCTPAttestation',
      ['0x1234'],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { data },
    });
    return { response, lines };
  } finally {
    await app.close();
  }
}

export interface CallDataVariant {
  name: string;
  data: string;
}

const SELECTOR_HEX_LENGTH = 10;
const WORD_HEX_LENGTH = 64;
const MINIMAL_BYTES_OFFSET = utils.hexZeroPad('0x20', 32).slice(2);

/**
 * Encodings of a single-`bytes`-argument call that decode to the same
 * arguments as `canonical` but differ from its canonical ABI encoding.
 */
export function nonCanonicalCallData(canonical: string): CallDataVariant[] {
  const selector = canonical.slice(0, SELECTOR_HEX_LENGTH);
  const offset = canonical.slice(
    SELECTOR_HEX_LENGTH,
    SELECTOR_HEX_LENGTH + WORD_HEX_LENGTH,
  );
  assert(
    offset === MINIMAL_BYTES_OFFSET,
    'Expected a call with one dynamic argument',
  );
  assert(canonical.endsWith('00'), 'Expected zero padding in the last word');
  return [
    { name: 'a trailing zero byte', data: canonical + '00' },
    {
      name: 'trailing text bytes',
      data: canonical + utils.hexlify(utils.toUtf8Bytes('/x')).slice(2),
    },
    { name: 'a trailing word', data: canonical + 'ff'.repeat(32) },
    { name: 'non-zero padding', data: canonical.slice(0, -2) + '01' },
    {
      name: 'a non-minimal offset',
      data:
        selector +
        utils.hexZeroPad('0x40', 32).slice(2) +
        '00'.repeat(32) +
        canonical.slice(SELECTOR_HEX_LENGTH + WORD_HEX_LENGTH),
    },
  ];
}
