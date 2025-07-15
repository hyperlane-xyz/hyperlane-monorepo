import type { Interface } from '@ethersproject/abi';
import type { BaseContract } from 'ethers';
import { ethers } from 'ethers';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk';

/**
 * Creates an Express handler that:
 * 1) reads `req.body.data`
 * 2) decodes it using the given Typechain contract factory & function name
 * 3) calls the provided service method with decoded args in order
 * 4) ABI-encodes the return value
 * 5) returns { data } as JSON
 *
 * @param contractFactory  A Typechain-generated contract factory with a `createInterface()` method
 * @param functionName     A function name that must exist on the contract's interface
 * @param serviceMethod    A method that takes the decoded arguments and returns a Promise of the result
 * @param options         Optional settings including skipResultEncoding and verifyRelayerSignatureUrl
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
    verifyRelayerSignatureUrl?: string;
  } = {},
) {
  const iface = contractFactory.createInterface();
  return async (req: Request, res: Response) => {
    const handlerLogger = req.log;
    handlerLogger.setBindings({ function: functionName as string });

    handlerLogger.info({ body: req.body }, 'Processing ABI handler request');

    try {
      const { skipResultEncoding = false, verifyRelayerSignatureUrl } = options;
      // request body fields
      const body = req.body || {};
      const sender = body.sender as string;
      const signature = body.signature as string;
      const data: string =
        (body.data as string) ||
        (req.params?.callData as string) ||
        (req.query?.callData as string) ||
        '';
      if (!data) {
        handlerLogger.warn({ body }, 'Missing callData in request');
        return res.status(400).json({ error: 'Missing callData' });
      }

      // Validation block for sender and signature
      const bodySchema = z.object({
        sender: z
          .string()
          .startsWith('0x')
          .length(42, 'Invalid Ethereum address'),
        signature: z.string().startsWith('0x'),
      });

      if (verifyRelayerSignatureUrl) {
        const parseResult = bodySchema.safeParse({ sender, signature });
        if (!parseResult.success) {
          handlerLogger.warn({ body }, 'Invalid sender or signature format');
          return res.status(400).json({
            error: 'Invalid sender or signature format',
            details: parseResult.error.errors,
          });
        }
      }

      let relayer: string | undefined;
      if (verifyRelayerSignatureUrl) {
        handlerLogger.info(
          { sender, data, verifyRelayerSignatureUrl },
          'Verifying relayer signature',
        );
        relayer = ethers.utils.verifyMessage(
          ethers.utils.arrayify(
            offchainLookupRequestMessageHash(
              sender,
              data,
              verifyRelayerSignatureUrl,
            ),
          ),
          signature,
        );
      }

      const decoded = iface.decodeFunctionData(functionName, data);
      const fragment = iface.getFunction(functionName);
      const args = fragment.inputs.map((_, i) => decoded[i]);
      const finalArgs = [...args];
      // For methods that expect (message, relayer, logger), we need to insert relayer before logger
      if (relayer) finalArgs.push(relayer);
      finalArgs.push(req.log); // Logger goes last
      const result = await serviceMethod(...finalArgs);

      handlerLogger.info(
        { reqBody: body },
        'ABI handler completed successfully',
      );

      if (skipResultEncoding) {
        handlerLogger.info({ reqBody: body }, 'Skipping result encoding');
        return res.json({ data: result });
      }
      const encoded = iface.encodeFunctionResult(
        functionName,
        Array.isArray(result) ? result : [result],
      );
      handlerLogger.info({ reqBody: body, encoded }, 'Result encoded');
      return res.json({ data: encoded });
    } catch (err: any) {
      handlerLogger.error(
        {
          reqBody: req.body,
          error: err.message,
          stack: err.stack,
        },
        `Error in ABI handler ${functionName}`,
      );
      return res.status(500).json({ error: err.message });
    }
  };
}
