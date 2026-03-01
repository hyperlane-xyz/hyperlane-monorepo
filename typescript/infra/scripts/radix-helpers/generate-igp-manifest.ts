import { Argv } from 'yargs';

import rawGasPrices from '../../config/environments/mainnet3/gasPrices.json' with { type: 'json' };
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

export function withOriginChain<T>(args: Argv<T>) {
  return args
    .describe('originChain', 'The chain for which IGP prices are calculated')
    .alias('o', 'origin-chain')
    .default('originChain', '')
    .demandOption('originChain');
}

const RADIX_ADDRESSES = {
  igp: 'component_rdx1cznxpn5m3kutzr6jrhgnvv0x7uhcs0rf8fl2w59hkclm6m7axzlqgu',
  // this is currently the deployer key and can be found in the secrets manager
  igp_owner:
    'account_rdx12x7j5plks60r73dus7znm6a4ryg8v89mw5dfkql74zvl0g3w60s822',
  // In Radix the ownership-mechanism is controlled by a batch. Who-ever holds
  // this badge is authorized to update/claim the IGP.
  igp_owner_badge:
    'resource_rdx1tkxgxg58vghrawkn4wvwz0h2vwqvhmy8e24rcn030re83schgt483g',
};

/**
 * Generates the Radix manifest to update IGP configs.
 */
async function main() {
  let { environment, chains, originChain } = await withOriginChain(
    withChains(getArgs()),
  ).argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  if (chains == undefined) {
    chains = config.supportedChainNames;
    console.log('No chains provided, generating config for all chains');
  }

  const gasPrices = rawGasPrices as unknown as {
    [key: string]: { amount: string; decimals: number };
  };
  const tokenPrices = rawTokenPrices as unknown as { [key: string]: string };

  const registry = await config.getRegistry(false);

  const tokenPriceConfigs = chains.map((chain) => {
    if (!tokenPrices[chain]) {
      throw Error(`No token price found for ${chain}`);
    }
    if (!gasPrices[chain]) {
      throw Error(`No gas price found for ${chain}`);
    }

    return {
      name: chain,
      domain_id: multiProvider.getDomainId(chain),
      token_price: tokenPrices[chain],
      gas_price_amount: gasPrices[chain].amount,
      gas_price_decimals: gasPrices[chain].decimals,
    };
  });

  if (!tokenPrices[originChain]) {
    throw Error(`No token price found for ${originChain}`);
  }

  const tupleLines = [];
  for (const entry of tokenPriceConfigs) {
    const token_price = parseFloat(entry.token_price);
    const origin_token_price = parseFloat(tokenPrices[originChain]);

    const destNativeTokenDecimals = (
      await registry.getChainMetadata(entry.name)
    )?.nativeToken?.decimals!;

    let ratio = token_price / origin_token_price;

    let gasPriceSmallestUnit =
      parseFloat(entry.gas_price_amount) *
      Math.pow(10, entry.gas_price_decimals);

    let originDestDecimalsRatio = Math.pow(
      10,
      // other than in cosmos we do not need to add the origin decimals here
      -destNativeTokenDecimals,
    );

    let gasPrice = gasPriceSmallestUnit * originDestDecimalsRatio;

    // Because splitting the scaling factor is not cumbersome,
    // we just use one of ratio and gasPrice for the entire calculation.
    // In the IGP the two factors are multiplied anyway.

    let combinedFactor = Math.round(gasPrice * ratio * 1e10);

    // Simulate a protocol fee of $0.2. Due to the mathematical nature it is not
    // possible to have an exact protocol fee, therefore we assume an average
    // gas of 318000 for a message. This isn't correct for all chains, but there
    // is currently no easy way to fetch the average gas consumption for each chain/application.
    const fee = (0.2 / 318000 / origin_token_price) * 1e10;
    combinedFactor += fee;

    // For Ethereum every transaction should always cost $1.5 flat.
    if (entry.domain_id == 1) {
      combinedFactor = (1.5 / (268000 + 50000) / origin_token_price) * 1e10;
    }

    tupleLines.push(
      `    Tuple(${entry.domain_id}u32, Tuple(Tuple(${Math.round(combinedFactor)}u128, 1u128), 250000u128))`,
    );
  }

  // The output needs to be submitted as an RADIX transaction
  console.log(`
CALL_METHOD
    Address("${RADIX_ADDRESSES.igp_owner}")
    "lock_fee"
    Decimal("10")
;
CALL_METHOD
  Address("${RADIX_ADDRESSES.igp_owner}")
  "create_proof_of_amount"
  Address("${RADIX_ADDRESSES.igp_owner_badge}")
  Decimal("1")
;
CALL_METHOD
    Address("${RADIX_ADDRESSES.igp}")
    "set_destination_gas_configs"
    Array<Tuple>(
${tupleLines.join(',\n')}
    )
;
CALL_METHOD
    Address("${RADIX_ADDRESSES.igp_owner}")
    "try_deposit_batch_or_refund"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
