import { utils } from 'ethers';

import { AbstractCcipReadIsm__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  IsmType,
  OffchainLookupIsmConfig,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';
import { WithAddress, ensure0x } from '@hyperlane-xyz/utils';

import type {
  CcipReadMetadataBuildResult,
  MetadataBuilder,
  MetadataContext,
} from './types.js';

function isHexString(value: unknown): value is string {
  // Minimum 64 hex bytes (128 chars) to avoid matching addresses (20B) and tx hashes (32B).
  // OffchainLookup is 4 + 5×32 = 164 bytes minimum, so 64B is a conservative floor.
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2}){64,}$/.test(value);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const MAX_BFS_ITERATIONS = 50;

function extractRevertData(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  let iterations = 0;

  while (queue.length && iterations < MAX_BFS_ITERATIONS) {
    iterations += 1;
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (isHexString(candidate)) return candidate;
    if (!isRecord(candidate)) continue;

    for (const key of ['data', 'error', 'cause', 'details', 'info']) {
      if (candidate[key] !== undefined) queue.push(candidate[key]);
    }
  }

  return undefined;
}

export class OffchainLookupMetadataBuilder implements MetadataBuilder {
  readonly type = IsmType.OFFCHAIN_LOOKUP;

  constructor(
    private readonly core: HyperlaneCore,
    private readonly readProviderRegistry: MultiProviderAdapter,
  ) {}

  async build(
    context: MetadataContext<WithAddress<OffchainLookupIsmConfig>>,
  ): Promise<CcipReadMetadataBuildResult> {
    const { ism, message } = context;
    const provider = this.readProviderRegistry.getEvmProvider(
      message.parsed.destination,
    );
    const contract = AbstractCcipReadIsm__factory.connect(
      ism.address,
      provider,
    );

    let revertData: string;
    try {
      // Should revert with OffchainLookup
      await contract.getOffchainVerifyInfo(message.message);
      throw new Error('Expected OffchainLookup revert');
    } catch (err: unknown) {
      const extracted = extractRevertData(err);
      if (!extracted) throw err;
      revertData = extracted;
    }

    const parsed = contract.interface.parseError(revertData);
    if (parsed.name !== 'OffchainLookup') {
      throw new Error(`Unexpected error ${parsed.name}`);
    }
    const [sender, urls, callData] = parsed.args as [
      string,
      string[],
      Uint8Array,
    ];

    const baseResult: Omit<CcipReadMetadataBuildResult, 'metadata'> = {
      type: IsmType.OFFCHAIN_LOOKUP,
      ismAddress: ism.address,
      urls,
    };

    const callDataHex = utils.hexlify(callData);

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
          const signature = await signer.signMessage(
            utils.arrayify(
              offchainLookupRequestMessageHash(
                sender,
                callDataHex,
                urlTemplate,
              ),
            ),
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
