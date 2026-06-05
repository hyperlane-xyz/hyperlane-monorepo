import { ChainMap, IgpConfig } from '@hyperlane-xyz/sdk';

/**
 * Per-fee-token IGP gas oracle configs for ERC20-denominated interchain gas
 * payments, keyed by:
 *
 *   local chain -> fee token address -> remote chain -> oracle config
 *
 * The wiring in `igp.ts` merges the entry for each local chain into that
 * chain's `IgpConfig.tokenOracleConfig`, which the SDK turns into per-fee-token
 * `StorageGasOracle` deployments + `setTokenGasOracles` calls on the IGP.
 *
 * Empty by default — keeping all token-IGP rollout changes contained to this
 * file. To enable a token on a chain, add an entry here. Only applies to
 * non-legacy IGPs (>= 11.3.0, EIP-1153 transient storage); legacy chains reject
 * it. The exchange rate is denominated in the fee token (price of the remote
 * native token quoted in the fee token), not the local native token.
 */
export const tokenGasOracleConfigs: ChainMap<
  NonNullable<IgpConfig['tokenOracleConfig']>
> = {};
