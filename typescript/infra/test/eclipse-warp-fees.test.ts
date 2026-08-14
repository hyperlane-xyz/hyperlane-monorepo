import { expect } from 'chai';

import { TokenFeeType, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  getEclipseWarpStrategyConfig,
  getFixedRoutingFeeConfig,
} from '../config/environments/mainnet3/warp/configGetters/utils.js';
import { WARP_FEES_TURNKEY_OWNER } from '../config/environments/mainnet3/governance/utils.js';

describe('Eclipse warp fee config', () => {
  const originInterchainAccountRouter =
    '0x4444444444444444444444444444444444444444';

  it('uses the RoutingFee owner for OQLF leaves', () => {
    const quoteSigner = '0x3333333333333333333333333333333333333333';
    const config = getFixedRoutingFeeConfig(
      WARP_FEES_TURNKEY_OWNER,
      ['destination'],
      1,
      undefined,
      [quoteSigner],
    );

    assert(config.type === TokenFeeType.RoutingFee, 'Expected RoutingFee');
    expect(config.owner).to.equal(WARP_FEES_TURNKEY_OWNER);
    expect(config.feeContracts.destination.type).to.equal(
      TokenFeeType.OffchainQuotedLinearFee,
    );
    expect(config.feeContracts.destination.owner).to.equal(
      WARP_FEES_TURNKEY_OWNER,
    );
  });

  it('writes only Turnkey-owned fees to one fresh submission file', () => {
    const usdcStrategy = getEclipseWarpStrategyConfig({
      route: 'usdc',
      evmChains: ['ethereum', 'arbitrum'],
      nonEvmChains: ['eclipsemainnet'],
      turnkeyFeeChains: new Set(['ethereum', 'arbitrum']),
      originInterchainAccountRouter,
    });
    const usdtStrategy = getEclipseWarpStrategyConfig({
      route: 'usdt',
      evmChains: ['ethereum', 'tron'],
      nonEvmChains: ['eclipsemainnet'],
      turnkeyFeeChains: new Set(['ethereum']),
      originInterchainAccountRouter,
    });

    const usdcEthereumFeeSubmitter = usdcStrategy.ethereum.feeSubmitter;
    const usdcArbitrumFeeSubmitter = usdcStrategy.arbitrum.feeSubmitter;
    assert(
      usdcEthereumFeeSubmitter?.type === 'file',
      'Expected USDC Turnkey fee file',
    );
    assert(
      usdcArbitrumFeeSubmitter?.type === 'file',
      'Expected shared USDC Turnkey fee file',
    );
    expect(usdcEthereumFeeSubmitter.filepath).to.equal(
      usdcArbitrumFeeSubmitter.filepath,
    );
    expect(usdcEthereumFeeSubmitter.filepath).to.match(
      /^\/tmp\/eclipse-usdc-turnkey-fees-\d+\.json$/,
    );

    const usdtEthereumFeeSubmitter = usdtStrategy.ethereum.feeSubmitter;
    assert(
      usdtEthereumFeeSubmitter?.type === 'file',
      'Expected USDT Turnkey fee file',
    );
    expect(usdtEthereumFeeSubmitter.filepath).to.match(
      /^\/tmp\/eclipse-usdt-turnkey-fees-\d+\.json$/,
    );

    assert(
      usdtStrategy.tron.feeSubmitter,
      'Expected Tron fee submitter to be configured',
    );
    expect(usdtStrategy.tron.feeSubmitter.type).to.equal(
      TxSubmitterType.INTERCHAIN_ACCOUNT,
    );
    expect(usdtStrategy.eclipsemainnet.feeSubmitter).to.equal(undefined);
    expect(usdtStrategy.ethereum.submitter.type).to.equal(
      TxSubmitterType.GNOSIS_TX_BUILDER,
    );
  });
});
