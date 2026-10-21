import { expect } from 'chai';
import { constants } from 'ethers';
import { parse, stringify } from 'yaml';

import { TokenFeeType, TokenType, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { awIcas } from '../config/environments/mainnet3/governance/ica/aw.js';
import { awSafes } from '../config/environments/mainnet3/governance/safe/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../config/environments/mainnet3/governance/utils.js';
import {
  getVictionETHStrategyConfig,
  getVictionETHWarpConfig,
} from '../config/environments/mainnet3/warp/configGetters/getVictionETHWarpConfig.js';
import { QUOTE_SIGNER } from '../config/environments/mainnet3/warp/consts.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getChainAddresses } from '../config/registry.js';
import { strategyConfigGetterMap } from '../config/warp.js';
import { legacyEthIcaRouter } from '../src/config/chain.js';

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

  it('preserves fee files through the getter map and YAML serialization', () => {
    const strategy = strategyConfigGetterMap[WarpRouteIds.VictionETH]();
    expect(strategy).to.have.keys(routeChains);
    const paths = new Set<string>();
    for (const chain of nativeChains) {
      const feeSubmitter = strategy[chain].feeSubmitter;
      assert(feeSubmitter?.type === 'file', `Missing fee file for ${chain}`);
      expect(feeSubmitter.chain).to.equal(chain);
      expect(feeSubmitter.filepath).to.match(
        /^\/tmp\/eth-viction-turnkey-fees-[\da-f-]+\.json$/,
      );
      paths.add(feeSubmitter.filepath);
    }
    expect(paths.size).to.equal(1);
    expect(strategy.viction.feeSubmitter).to.equal(undefined);
    const roundTripped: unknown = parse(stringify(strategy));
    expect(roundTripped).to.deep.equal(strategy);

    const nextFeeSubmitter =
      getVictionETHStrategyConfig().ethereum.feeSubmitter;
    assert(nextFeeSubmitter?.type === 'file', 'Missing fresh fee file');
    expect(paths.has(nextFeeSubmitter.filepath)).to.equal(false);
  });

  it('keeps router governance on the AW Safe and the correct ICAs', () => {
    const strategy = getVictionETHStrategyConfig();
    const safeSubmitter = {
      type: TxSubmitterType.GNOSIS_TX_BUILDER,
      chain: 'ethereum',
      safeAddress: awSafes.ethereum,
      version: '1.0',
    };
    expect(strategy.ethereum.submitter).to.deep.equal(safeSubmitter);
    for (const chain of routeChains.filter((chain) => chain !== 'ethereum')) {
      expect(strategy[chain].submitter).to.deep.equal({
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: 'ethereum',
        destinationChain: chain,
        owner: awSafes.ethereum,
        originInterchainAccountRouter:
          chain === 'viction'
            ? legacyEthIcaRouter
            : getChainAddresses().ethereum.interchainAccountRouter,
        internalSubmitter: safeSubmitter,
      });
    }
  });
});
