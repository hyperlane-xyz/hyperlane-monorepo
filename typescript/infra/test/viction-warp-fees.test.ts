import { expect } from 'chai';
import { constants } from 'ethers';

import { TokenFeeType, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { awIcas } from '../config/environments/mainnet3/governance/ica/aw.js';
import { awSafes } from '../config/environments/mainnet3/governance/safe/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../config/environments/mainnet3/governance/utils.js';
import { getVictionETHWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getVictionETHWarpConfig.js';
import { QUOTE_SIGNER } from '../config/environments/mainnet3/warp/consts.js';

const nativeChains = ['arbitrum', 'base', 'ethereum', 'optimism', 'robinhood'];
const routeChains = [...nativeChains, 'viction'];

describe('Viction ETH warp fees', () => {
  it('configures twenty 30 bps quoted leaves without charging Viction paths', async () => {
    const routerConfigs = Object.fromEntries(
      routeChains.map((chain) => [chain, { mailbox: constants.AddressZero }]),
    );
    const configs = await getVictionETHWarpConfig(routerConfigs, {});
    expect(configs).to.have.keys(routeChains);

    for (const chain of nativeChains) {
      const config = configs[chain];
      expect(config.type).to.equal(TokenType.native);
      expect(config.owner).to.equal(
        chain === 'ethereum' ? awSafes.ethereum : awIcas[chain],
      );
      const fee = config.tokenFee;
      assert(
        fee && typeof fee !== 'string' && fee.type === TokenFeeType.RoutingFee,
        `Expected RoutingFee on ${chain}`,
      );
      expect(fee.owner).to.equal(WARP_FEES_TURNKEY_OWNER);
      expect(fee.feeContracts).to.have.keys(
        nativeChains.filter((destination) => destination !== chain),
      );
      for (const leaf of Object.values(fee.feeContracts)) {
        assert(
          leaf.type === TokenFeeType.OffchainQuotedLinearFee,
          'Expected OffchainQuotedLinearFee',
        );
        expect(leaf.bps).to.equal(30);
        expect(leaf.owner).to.equal(WARP_FEES_TURNKEY_OWNER);
        expect(leaf.quoteSigners).to.deep.equal([QUOTE_SIGNER]);
      }
    }

    expect(configs.viction.type).to.equal(TokenType.synthetic);
    expect(configs.viction.owner).to.equal(awIcas.viction);
    expect(configs.viction.tokenFee).to.equal(undefined);
  });
});
