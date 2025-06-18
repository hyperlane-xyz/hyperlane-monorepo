import type { Interface } from '@ethersproject/abi';
import type { BaseContract } from 'ethers';
import { ethers } from 'ethers';
import type { Request, Response } from 'express';

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
        return res.status(400).json({ error: 'Missing callData' });
      }

      let relayer: string | undefined;
      if (verifyRelayerSignatureUrl) {
        if (!sender || !signature) {
          return res.status(400).json({ error: 'Missing sender or signature' });
        }
        const messageHash = ethers.utils.solidityKeccak256(
          ['string', 'address', 'bytes', 'string'],
          ['HYPERLANE_OFFCHAINLOOKUP', sender, data, verifyRelayerSignatureUrl],
        );
        relayer = ethers.utils.verifyMessage(
          ethers.utils.arrayify(messageHash),
          signature,
        );
      }

      const decoded = iface.decodeFunctionData(functionName, data);
      const fragment = iface.getFunction(functionName);
      const args = fragment.inputs.map((_, i) => decoded[i]);
      const finalArgs = [...args];
      if (relayer) finalArgs.push(relayer);
      const result = await serviceMethod(...finalArgs);

      if (skipResultEncoding) {
        return res.json({ data: result });
      }
      const encoded = iface.encodeFunctionResult(
        functionName,
        Array.isArray(result) ? result : [result],
      );
      return res.json({ data: encoded });
    } catch (err: any) {
      console.error(`Error in ABI handler ${functionName}:`, err);
      return res.status(500).json({ error: err.message });
    }
  };
}
