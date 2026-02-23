import { bytesToHex, decodeErrorResult, hexToBytes, type Hex } from 'viem';

import { AbstractCcipReadIsm__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  IsmType,
  OffchainLookupIsmConfig,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk';
import { WithAddress, ensure0x } from '@hyperlane-xyz/utils';

import type {
  CcipReadMetadataBuildResult,
  MetadataBuilder,
  MetadataContext,
} from './types.js';

const OFFCHAIN_LOOKUP_ERROR_ABI = [
  {
    type: 'error',
    name: 'OffchainLookup',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'urls', type: 'string[]' },
      { name: 'callData', type: 'bytes' },
      { name: 'callbackFunction', type: 'bytes4' },
      { name: 'extraData', type: 'bytes' },
    ],
  },
] as const;

function isHexString(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function extractRevertData(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (isHexString(candidate)) return candidate;
    if (typeof candidate !== 'object') continue;

    const record = candidate as Record<string, unknown>;
    for (const key of ['data', 'error', 'cause', 'details', 'info']) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

function decodeOffchainLookup(
  revertData: Hex,
  contract: ReturnType<typeof AbstractCcipReadIsm__factory.connect>,
): { sender: string; urls: string[]; callDataHex: Hex } {
  const parseArgs = (
    args: unknown,
  ): { sender: string; urls: string[]; callDataHex: Hex } => {
    let sender: unknown;
    let urls: unknown;
    let callData: unknown;

    if (Array.isArray(args)) {
      [sender, urls, callData] = args;
    } else if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>;
      sender = record.sender ?? record[0];
      urls = record.urls ?? record[1];
      callData = record.callData ?? record[2];
    } else {
      throw new Error('Unexpected OffchainLookup args');
    }

    const callDataHex = isHexString(callData)
      ? callData
      : bytesToHex(callData as Uint8Array);

    return {
      sender: String(sender).toLowerCase(),
      urls: (urls as unknown[]).map((url) => String(url)),
      callDataHex,
    };
  };

  const parsed = contract.interface.parseError(revertData);
  if (parsed?.name === 'OffchainLookup') {
    return parseArgs(parsed.args);
  }

  const fallback = decodeErrorResult({
    abi: OFFCHAIN_LOOKUP_ERROR_ABI,
    data: revertData,
  });

  if (fallback.errorName === 'OffchainLookup') {
    return parseArgs(fallback.args);
  }

  throw new Error(`Unexpected error ${parsed?.name ?? fallback.errorName}`);
}

type SignerLike = {
  signMessage?: (message: string | Uint8Array) => Promise<string>;
  getAddress?: () => Promise<string>;
  address?: string;
  provider?: {
    send?: (method: string, params: unknown[]) => Promise<unknown>;
  };
};

async function signOffchainLookupRequest(
  signer: unknown,
  requestHash: Hex,
): Promise<Hex> {
  const signerLike = signer as SignerLike;

  if (typeof signerLike.signMessage === 'function') {
    return ensure0x(await signerLike.signMessage(hexToBytes(requestHash)));
  }

  const address =
    typeof signerLike.getAddress === 'function'
      ? await signerLike.getAddress()
      : signerLike.address;
  const send = signerLike.provider?.send;
  if (address && typeof send === 'function') {
    try {
      const signature = await send('personal_sign', [requestHash, address]);
      if (isHexString(signature)) return signature;
    } catch {
      // fallback to eth_sign below
    }
    const signature = await send('eth_sign', [address, requestHash]);
    if (isHexString(signature)) return signature;
  }

  throw new Error('Signer does not support message signing');
}

export class OffchainLookupMetadataBuilder implements MetadataBuilder {
  readonly type = IsmType.OFFCHAIN_LOOKUP;
  private core: HyperlaneCore;

  constructor(core: HyperlaneCore) {
    this.core = core;
  }

  async build(
    context: MetadataContext<WithAddress<OffchainLookupIsmConfig>>,
  ): Promise<CcipReadMetadataBuildResult> {
    const { ism, message } = context;
    const provider = this.core.multiProvider.getProvider(
      message.parsed.destination,
    );
    const contract = AbstractCcipReadIsm__factory.connect(
      ism.address,
      provider,
    );

    let revertData: Hex;
    try {
      // Should revert with OffchainLookup
      await contract.getOffchainVerifyInfo(message.message);
      throw new Error('Expected OffchainLookup revert');
    } catch (err: unknown) {
      revertData = extractRevertData(err) as Hex;
      if (!revertData) throw err;
    }

    const { sender, urls, callDataHex } = decodeOffchainLookup(
      revertData,
      contract,
    );

    const baseResult: Omit<CcipReadMetadataBuildResult, 'metadata'> = {
      type: IsmType.OFFCHAIN_LOOKUP,
      ismAddress: ism.address,
      urls,
    };

    const signer = this.core.multiProvider.getSigner(
      message.parsed.destination,
    );

    for (const urlTemplate of urls) {
      const url = urlTemplate
        .replace('{sender}', sender)
        .replace('{data}', callDataHex);

      let res: Response;
      try {
        if (urlTemplate.includes('{data}')) {
          res = await fetch(url);
        } else {
          const signature = await signOffchainLookupRequest(
            signer,
            offchainLookupRequestMessageHash(
              sender,
              callDataHex,
              urlTemplate,
            ) as Hex,
          );
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender,
              data: callDataHex,
              signature,
            }),
          });
        }
      } catch (error: any) {
        this.core.logger.warn(
          `CCIP-read metadata fetch failed for ${url}: ${error}`,
        );
        // try next URL
        continue;
      }

      try {
        const responseJson = await res.json();
        if (res.ok) {
          return {
            ...baseResult,
            metadata: ensure0x(responseJson.data),
          };
        }
      } catch (error) {
        this.core.logger.warn(
          `CCIP-read metadata fetch failed for ${url}: ${error}`,
        );
        // try next URL
      }
    }

    // Return without metadata if all URLs failed
    return baseResult;
  }
}
