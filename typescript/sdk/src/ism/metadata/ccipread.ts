import { TypedDataField, utils } from 'ethers';

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

  /**
   * Generates an EIP-712 authentication signature over the given data and sender.
   */
  private async generateAuthSignature(
    ismAddress: string,
    callDataHex: string,
    sender: string,
    destinationDomain: number,
  ): Promise<string> {
    const signer = this.core.multiProvider.getSigner(destinationDomain);
    const chainId = await this.core.multiProvider.getChainId(destinationDomain);
    const domain = {
      name: 'Hyperlane CCIPReadAuth',
      version: '1',
      chainId,
      verifyingContract: ismAddress,
    };
    const types: Record<string, TypedDataField[]> = {
      Auth: [
        { name: 'data', type: 'bytes' },
        { name: 'sender', type: 'address' },
      ],
    };
    const value = { data: callDataHex, sender };
    // @ts-ignore ethers types somehow don't have this function
    return await signer._signTypedData(domain, types, value);
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

    const signature = await this.generateAuthSignature(
      ism.address,
      callDataHex,
      sender,
      message.parsed.destination,
    );

    for (const urlTemplate of urls) {
      const url = urlTemplate
        .replace('{sender}', sender)
        .replace('{data}', callDataHex);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender, data: callDataHex, signature }),
        });
        const responseJson = await res.json();

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
