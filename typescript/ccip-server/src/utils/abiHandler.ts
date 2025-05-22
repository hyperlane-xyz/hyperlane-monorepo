import { Fragment, Interface } from '@ethersproject/abi';
import type { Request, Response } from 'express';

/**
 * Creates an Express handler that:
 * 1) reads `req.body.data`
 * 2) decodes it using the given ABI & function name
 * 3) calls the provided service method with decoded args in order
 * 4) ABI-encodes the return value
 * 5) returns { data } as JSON
 *
 * @param abi           ABI fragment or array of fragments describing the function
 * @param functionName  The name of the function to decode
 * @param serviceMethod A method that takes the decoded arguments and returns a Promise of the result
 */
export function createAbiHandler<F extends string>(
  abi: string | Fragment | Array<string | Fragment>,
  functionName: F,
  serviceMethod: (...args: any[]) => Promise<any>,
  skipResultEncoding: boolean = false,
) {
  // Normalize ABI to an array of fragments
  const fragments: Array<string | Fragment> = Array.isArray(abi) ? abi : [abi];
  const iface = new Interface(fragments);
  return async (req: Request, res: Response) => {
    try {
      // Support POST body or GET URL param/query
      const data: string =
        (req.body && (req.body.data as string)) ||
        (req.params && (req.params.callData as string)) ||
        (req.query && (req.query.callData as string)) ||
        '';
      if (!data) {
        return res.status(400).json({ error: 'Missing callData' });
      }
      // Decode function data
      const decoded = iface.decodeFunctionData(functionName, data);
      // Extract arguments in order
      const fragment = iface.getFunction(functionName);
      const args = fragment.inputs.map((_, i) => decoded[i]);
      // Invoke service and get result
      const result = await serviceMethod(...args);
      // ABI-encode according to the function's outputs
      const encoded = iface.encodeFunctionResult(
        functionName,
        Array.isArray(result) ? result : [result],
      );
      // If skipResultEncoding is true, return the raw result
      return res.json({ data: skipResultEncoding ? result : encoded });
    } catch (err: any) {
      console.error(`Error in ABI handler ${functionName}:`, err);
      return res.status(500).json({ error: err.message });
    }
  };
}
