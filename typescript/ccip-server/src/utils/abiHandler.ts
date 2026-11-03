import type { Interface } from '@ethersproject/abi';
import type { BaseContract } from 'ethers';
import type { FastifyReply } from 'fastify';

import type { CcipRequest } from '../http.js';
import {
  AttestationPendingError,
  CommitmentAccessDeniedError,
} from './errors.js';

export interface AbiRequestBody {
  data?: unknown;
  sender?: unknown;
  signature?: unknown;
  origin_tx_hash?: unknown;
}

export interface AbiRoute {
  Body: AbiRequestBody;
  Params: { sender?: string; callData?: string };
  Querystring: { callData?: string };
}

export const ABI_ROUTE_OPTIONS = {
  schema: {
    response: {
      200: {
        additionalProperties: false,
        properties: { data: { type: 'string' } },
        required: ['data'],
        type: 'object',
      },
    },
  },
} as const;

/**
 * Creates a Fastify handler that:
 * 1) reads `request.body.data`
 * 2) decodes it using the given Typechain contract factory & function name
 * 3) calls the provided service method with decoded args in order
 * 4) ABI-encodes the return value
 * 5) returns { data } as JSON
 *
 * @param contractFactory  A Typechain-generated contract factory with a `createInterface()` method
 * @param functionName     A function name that must exist on the contract's interface
 * @param serviceMethod    A method that takes the decoded arguments and returns a Promise of the result
 * @param options         Optional settings including skipResultEncoding and authenticatedRelayer
 */
export function createAbiHandler<
  Factory extends {
    createInterface(): Interface;
    connect(...args: any[]): BaseContract;
  },
  F extends keyof ReturnType<Factory['connect']>['functions'] & string,
>(
  contractFactory: Factory,
  functionName: F,
  serviceMethod: (...args: any[]) => Promise<any>,
  options: {
    skipResultEncoding?: boolean;
    authenticatedRelayer?: (request: CcipRequest<AbiRoute>) => string;
  } = {},
) {
  const iface = contractFactory.createInterface();
  return async (request: CcipRequest<AbiRoute>, reply: FastifyReply) => {
    const handlerLogger = request.log;
    handlerLogger.setBindings({ function: functionName as string });
    const logContext = {
      requestId: request.id,
      ...(options.authenticatedRelayer ? {} : { reqBody: request.body }),
    };

    handlerLogger.info(logContext, 'Processing ABI handler request');

    try {
      const { skipResultEncoding = false } = options;
      // request body fields
      const body = request.body ?? {};
      const data: string =
        (typeof body.data === 'string' ? body.data : '') ||
        request.params.callData ||
        request.query.callData ||
        '';
      if (!data) {
        handlerLogger.warn(logContext, 'Missing callData in request');
        return reply.code(400).send({ error: 'Missing callData' });
      }

      const relayer = options.authenticatedRelayer?.(request);

      const decoded = iface.decodeFunctionData(functionName, data);
      const fragment = iface.getFunction(functionName);
      const args = fragment.inputs.map((_, i) => decoded[i]);
      const finalArgs = [...args];
      // For methods that expect (message, relayer, logger), we need to insert relayer before logger
      if (relayer) finalArgs.push(relayer);
      finalArgs.push(request.log); // Logger goes last
      const result = await serviceMethod(...finalArgs);

      handlerLogger.info(logContext, 'ABI handler completed successfully');

      if (skipResultEncoding) {
        handlerLogger.info(logContext, 'Skipping result encoding');
        return reply.send({ data: result });
      }
      const encoded = iface.encodeFunctionResult(
        functionName,
        Array.isArray(result) ? result : [result],
      );
      handlerLogger.info(
        { ...logContext, ...(options.authenticatedRelayer ? {} : { encoded }) },
        'Result encoded',
      );
      return reply.send({ data: encoded });
    } catch (error: unknown) {
      if (error instanceof CommitmentAccessDeniedError) {
        return reply.code(403).send({ error: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AttestationPendingError) {
        // Expected polling state: keep the response contract and request metrics,
        // but avoid repeatedly serializing calldata and stacks at error level.
        handlerLogger.debug({ error: message }, 'CCTP attestation pending');
      } else {
        handlerLogger.error(
          {
            ...logContext,
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
          },
          `Error in ABI handler ${functionName}`,
        );
      }
      return reply.code(500).send({ error: message });
    }
  };
}
