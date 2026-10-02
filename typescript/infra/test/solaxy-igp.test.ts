import { expect } from 'chai';

import oracleConfigs from '../../../rust/sealevel/environments/mainnet3/gas-oracle-configs.json' with { type: 'json' };
import { getIgp } from '../config/environments/mainnet3/igp.js';
import tokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { getChain } from '../config/registry.js';

describe('Solaxy IGP decimal compensation', () => {
  it('keeps both deployment paths above the fee floor in six-decimal SOLX', () => {
    const oracle = getIgp().solaxy.oracleConfig.solanamainnet;
    expect(oracle).to.deep.equal(
      oracleConfigs.solaxy.solanamainnet.oracleConfig,
    );
    expect(getChain('solaxy').nativeToken.decimals).to.equal(6);
    expect(oracle.tokenDecimals).to.equal(9);
    // Matches the Sealevel compute_gas_fee integer arithmetic. The remote
    // and hardcoded local decimals are both nine, so no conversion occurs.
    const atomicFee =
      (900_000n * BigInt(oracle.gasPrice) * BigInt(oracle.tokenExchangeRate)) /
      10n ** 19n;
    expect(atomicFee).to.equal(15_038_681_741n);
    const usdFee = (Number(atomicFee) / 10 ** 6) * Number(tokenPrices.solaxy);
    expect(usdFee).to.be.at.least(0.45);
  });
});
