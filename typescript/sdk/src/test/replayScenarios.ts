import { Contract, type providers } from 'ethers';

import { TokenType } from '../token/config.js';
import type { EvmWarpRouteReader } from '../token/EvmWarpRouteReader.js';

// A raw contract read replayed through ethers so the real CALL_EXCEPTION
// wrapping of the recorded node response is observable.
export interface ReplayProbe {
  to: string;
  // human-readable ABI fragment, e.g. 'feeHook() view returns (address)'
  signature: string;
  args: unknown[];
}

export interface ReplayScenario {
  // fixture file name, without extension
  scenario: string;
  chain: string;
  chainId: number;
  router: string;
  run(reader: EvmWarpRouteReader, router: string): Promise<unknown>;
  probes: ReplayProbe[];
}

export const REPLAY_SCENARIOS: ReplayScenario[] = [
  {
    scenario: 'bat-aleo-ethereum-collateral',
    chain: 'ethereum',
    chainId: 1,
    router: '0x516e156e987175d74614cc2bC960f148A610f0b3',
    run: (reader, router) => reader.deriveTokenType(router),
    probes: [
      {
        to: '0x0D8775F648430679A709E98d2b0Cb6250d2887EF',
        signature: 'mintingCurrentLimitOf(address) view returns (uint256)',
        args: ['0x516e156e987175d74614cc2bC960f148A610f0b3'],
      },
    ],
  },
  {
    scenario: 'magic-abstract-base-router',
    chain: 'base',
    chainId: 8453,
    router: '0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43',
    run: (reader, router) => reader.fetchScale(router),
    probes: [
      {
        to: '0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43',
        signature: 'scale() view returns (uint256)',
        args: [],
      },
    ],
  },
  {
    scenario: 'usdc-lukso-router',
    chain: 'lukso',
    chainId: 42,
    router: '0xE0C2e4F894D4Cd33626e33b24582559F3156E1Ab',
    run: async (reader, router) => ({
      feeHook: await reader.fetchFeeHook(router),
      scale: await reader.fetchScale(router),
    }),
    probes: [
      {
        to: '0xE0C2e4F894D4Cd33626e33b24582559F3156E1Ab',
        signature: 'feeHook() view returns (address)',
        args: [],
      },
    ],
  },
  {
    scenario: 'lyx-lukso-native-router',
    chain: 'lukso',
    chainId: 42,
    router: '0xC210B2cB65ed3484892167F5e05F7ab496Ab0598',
    run: (reader, router) => reader.deriveWarpRouteConfig(router),
    probes: [
      {
        to: '0xC210B2cB65ed3484892167F5e05F7ab496Ab0598',
        signature: 'feeRecipient() view returns (address)',
        args: [],
      },
      {
        to: '0xC210B2cB65ed3484892167F5e05F7ab496Ab0598',
        signature: 'feeHook() view returns (address)',
        args: [],
      },
    ],
  },
  {
    scenario: 'blend-fluent-collateral',
    chain: 'fluent',
    chainId: 25363,
    router: '0x2bef59e84615371304bd731601f6344F5F304504',
    run: (reader, router) => reader.deriveTokenType(router),
    probes: [
      {
        to: '0x1385B8f55A84f2BdA13EeD4099d29Eae03d553b2',
        signature: 'mintingCurrentLimitOf(address) view returns (uint256)',
        args: ['0x2bef59e84615371304bd731601f6344F5F304504'],
      },
    ],
  },
];

export const EXPECTED_TOKEN_TYPE = TokenType.collateral;

export async function runProbe(
  provider: providers.Provider,
  probe: ReplayProbe,
): Promise<unknown> {
  const contract = new Contract(
    probe.to,
    [`function ${probe.signature}`],
    provider,
  );
  const name = probe.signature.slice(0, probe.signature.indexOf('('));
  return contract[name](...probe.args);
}
