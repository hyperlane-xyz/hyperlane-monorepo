import { utils } from 'ethers';

import { ICcipReadIsm__factory } from '@hyperlane-xyz/core';
import { WithAddress } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { CCIPReadIsmConfig, IsmType } from '../types.js';

import type { MetadataBuilder, MetadataContext } from './types.js';

export class CcipReadMetadataBuilder implements MetadataBuilder {
  readonly type = IsmType.CCIP;
  private core: HyperlaneCore;

  constructor(core: HyperlaneCore) {
    this.core = core;
  }

  async build(
    context: MetadataContext<WithAddress<CCIPReadIsmConfig>>,
  ): Promise<string> {
    const { ism, message } = context;
    const provider = this.core.multiProvider.getProvider(message.parsed.origin);
    const contract = ICcipReadIsm__factory.connect(ism.address, provider);

    let revertData: string;
    try {
      // Should revert with OffchainLookup
      await contract.getOffchainVerifyInfo(message.message);
      throw new Error('Expected OffchainLookup revert');
    } catch (err: any) {
      revertData = err.error?.data || err.data;
      if (!revertData) throw err;
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
    const callDataHex = utils.hexlify(callData);

    for (const urlTemplate of urls) {
      const url = urlTemplate
        .replace('{sender}', sender)
        .replace('{data}', callDataHex);
      try {
        let responseJson: any;
        if (urlTemplate.includes('{data}')) {
          const res = await fetch(url);
          responseJson = await res.json();
        } else {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, data: callDataHex }),
          });
          responseJson = await res.json();
        }
        const rawHex = responseJson.data as string;
        return rawHex.startsWith('0x') ? rawHex : `0x${rawHex}`;
      } catch (error: any) {
        this.core.logger.warn(
          `CCIP-read metadata fetch failed for ${url}: ${error}`,
        );
        // try next URL
      }
    }

    throw new Error('Could not fetch CCIP-read metadata');
  }
}
