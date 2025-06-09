import type { Interface } from '@ethersproject/abi';
import type { BaseContract } from 'ethers';
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
 * @param skipResultEncoding If true, skips ABI-encoding the result and returns it as-is
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
  skipResultEncoding: boolean = false,
) {
  const iface = contractFactory.createInterface();
  return async (req: Request, res: Response) => {
    try {
      const data: string =
        (req.body && (req.body.data as string)) ||
        (req.params && (req.params.callData as string)) ||
        (req.query && (req.query.callData as string)) ||
        '';
      if (!data) {
        return res.status(400).json({ error: 'Missing callData' });
      }
      // Decode function data (compiler enforces existence of functionName)
      const decoded = iface.decodeFunctionData(functionName, data);
      const fragment = iface.getFunction(functionName);
      const args = fragment.inputs.map((_, i) => decoded[i]);
      const result = await serviceMethod(...args);
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
