import Fastify from 'fastify';
import { pino } from 'pino';

import { CctpService__factory } from '@hyperlane-xyz/core';

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
