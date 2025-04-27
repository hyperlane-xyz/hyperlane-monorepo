import { Contexts } from '../../config/contexts.js';
import { KeyFunderHelmManager } from '../../src/funding/key-funder.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';
import { getHelloWorldConfig } from '../helloworld/utils.js';

async function main() {
  const highUrgency = false;

  const relayerBalanceMultiplier = highUrgency ? 1.5 : 2;

  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  const manager = KeyFunderHelmManager.forEnvironment(environment);

  const helloWorldConfig = getHelloWorldConfig(envConfig, agentConfig.context);

  const chains = agentConfig.contextChainNames.relayer.sort();

  const minKeyFunderBalances = chains.map((chain) => {
    const desiredRelayerBalance = parseFloat(
      manager.config.desiredBalancePerChain[chain],
    );
    const desiredKathyBalance = manager.config.desiredKathyBalancePerChain[
      chain
    ]
      ? parseFloat(manager.config.desiredKathyBalancePerChain[chain])
      : 0;
    // Apply a multiplier to the desired relayer balance.
    let minBalance =
      (desiredRelayerBalance + desiredKathyBalance) * relayerBalanceMultiplier;

    return { chain, minBalance };
  });

  const keyFunderQueryFragments = minKeyFunderBalances.map(
    ({ chain, minBalance }) => {
      return `last_over_time(hyperlane_wallet_balance{wallet_name="key-funder", chain="${chain}"}[1d]) - ${minBalance} or`;
    },
  );

  const query = `
# Note: use last_over_time(hyperlane_wallet_balance{}[1d]) to be resilient to gaps in the \`hyperlane_wallet_balance\`
# that occur due to key funder only running every hour or so.

min by (chain, wallet_address, wallet_name) (
    # Mainnets
    ${keyFunderQueryFragments.join('\n    ')}

    # Mainnets that don't use key-funder and all funds are stored in the relayer's wallet

    # Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"eclipsemainnet"}[1d]) - 1 or
    # Any ATA payer on Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.01 or

    # Solana
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"solanamainnet"}[1d]) - 5 or
    # Any ATA payer on Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"solanamainnet"}[1d]) - 0.2 or

    # Nautilus (v2)
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="nautilus"}[1d]) - 1500 or
    # TODO: we can re-add mainnet3 after the upcoming Solana deploy
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="solana", hyperlane_deployment!="mainnet3"}[1d]) - 0.75 or
    last_over_time(hyperlane_wallet_balance{wallet_name="nautilus-zbc-rent", chain="solana"}[1d]) - 0.75 or

    # Neutron context
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="mantapacific", hyperlane_context="neutron"}[1d]) - 0.3 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="arbitrum", hyperlane_context="neutron"}[1d]) - 0.3 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="neutron", hyperlane_context="neutron"}[1d]) - 1500 or

    # Injective
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="injective", wallet_address!~"inj1ddw6pm84zmtpms0gpknfsejkk9v6t0ergjpl30|inj1ds32d5t26j7gauvtly86lk6uh06ear3jvqllaw"}[1d]) / 1000000000000) - 3 or

    # Stride
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="stride"}[1d])) - 10
)`;

  console.log(query);
}

main().catch(console.error);
