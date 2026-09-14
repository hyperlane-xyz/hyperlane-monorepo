import { utils } from 'ethers';

import { AbstractCcipReadIsm__factory } from '@hyperlane-xyz/core';
import {
  HyperlaneCore,
  IsmType,
  LayerZeroV2IsmConfig,
  OffchainLookupIsmConfig,
  WormholeIsmConfig,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk';
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

/**
 * ISMs that answer `getOffchainVerifyInfo` with an EIP-3668 `OffchainLookup`.
 * Only the ISM address is needed to trigger it, so the direct-VAA Wormhole
 * router reuses this builder unchanged.
 */
export type OffchainLookupContextConfig =
  | OffchainLookupIsmConfig
  | (WormholeIsmConfig & { type: typeof IsmType.WORMHOLE_VAA })
  | Extract<
      LayerZeroV2IsmConfig,
      { type: typeof IsmType.LAYER_ZERO_V2_CCIP_READ }
    >;

export class OffchainLookupMetadataBuilder implements MetadataBuilder {
  readonly type = IsmType.OFFCHAIN_LOOKUP;
  private core: HyperlaneCore;

  constructor(core: HyperlaneCore) {
    this.core = core;
  }

  async build(
    context: MetadataContext<WithAddress<OffchainLookupContextConfig>>,
  ): Promise<CcipReadMetadataBuildResult> {
    const { ism, message, dispatchTx } = context;
    const provider = this.core.multiProvider.getProvider(
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
      type: ism.type,
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
              // Matches the Rust relayer: lets a service locate the origin
              // event directly instead of querying the Explorer for it.
              origin_tx_hash: dispatchTx.transactionHash,
            }),
          });
        }
      } catch (error: unknown) {
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
        this.core.logger.warn(
          `CCIP-read metadata fetch returned ${res.status} for ${url}: ${JSON.stringify(responseJson)}`,
        );
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
