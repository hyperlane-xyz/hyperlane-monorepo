import { expect } from 'chai';

import oracleConfigs from '../../../rust/sealevel/environments/mainnet3/gas-oracle-configs.json' with { type: 'json' };
import { getIgp } from '../config/environments/mainnet3/igp.js';
import tokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { getChain } from '../config/registry.js';

describe('Solaxy IGP decimal compensation', () => {
  it('prices the configured 900,000-gas sample in six-decimal SOLX consistently across deployment paths', () => {
    const solaxyOracles = getIgp().solaxy.oracleConfig;
    for (const remote of ['ethereum', 'solanamainnet'] as const) {
      expect(solaxyOracles[remote]).to.deep.equal(
        oracleConfigs.solaxy[remote].oracleConfig,
      );
    }
    const oracle = solaxyOracles.solanamainnet;
    expect(getChain('solaxy').nativeToken?.decimals).to.equal(6);
    expect(oracle.tokenDecimals).to.equal(9);
    // This checks a sample quote, not an enforced minimum or a live oracle.
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
