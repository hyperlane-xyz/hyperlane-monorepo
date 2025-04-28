import { expect } from 'chai';
import { ProcessOutput } from 'zx';

import { IRegistry } from '@hyperlane-xyz/registry';
import { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { getContext } from '../../context/context.js';
import {
  ANVIL_KEY,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  REGISTRY_PATH,
  handlePrompts,
} from '../commands/helpers.js';
import { hyperlaneWarpAddresses } from '../commands/warp.js';

function parseJsonFromOutput({
  stdout: output,
}: ProcessOutput): Record<string, any> {
  try {
    const markerStart = 'Warp route contracts';
    const startIndex = output.indexOf(markerStart);
    const firstNewlineIndex = output.indexOf('\n', startIndex);
    if (firstNewlineIndex === -1) {
      throw new Error('Invalid format: no newline after marker');
    }

    const jsonString = output.substring(firstNewlineIndex + 1);
    return JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`Failed to parse JSON from command output: ${output}`);
  }
}

function getTokenType(standard: string): 'native' | 'synthetic' {
  return standard.includes('Native') ? 'native' : 'synthetic';
}

function verifyAddressesMatchConfig(
  commandOutput: ProcessOutput,
  warpRouteConfig: WarpCoreConfig,
  chainName?: string,
) {
  const addresses = parseJsonFromOutput(commandOutput);
  expect(addresses, 'Address output should be an object').to.be.an('object');

  if (chainName) {
    // Verify single chain output
    const tokenConfig = warpRouteConfig.tokens.find(
      (token) => token.chainName === chainName,
    );
    expect(tokenConfig, `Token configuration for chain ${chainName} not found`)
      .to.exist;

    if (!tokenConfig) return; // TypeScript guard

    const tokenType = getTokenType(tokenConfig.standard);
    expect(
      addresses,
      `Address output should have property ${tokenType}`,
    ).to.have.property(tokenType);
    expect(
      addresses[tokenType],
      `${tokenType} address should match configuration`,
    ).to.equal(tokenConfig.addressOrDenom);
  } else {
    // Verify all chains output
    const expectedChains = warpRouteConfig.tokens.map(
      (token) => token.chainName,
    );
    expect(
      Object.keys(addresses),
      'Address output should include all expected chains',
    ).to.have.members(expectedChains);

    // Verify each token in the configuration
    warpRouteConfig.tokens.forEach((tokenConfig) => {
      const { chainName, standard, addressOrDenom } = tokenConfig;
      const tokenType = getTokenType(standard);

      if (chainName in addresses) {
        const chainAddresses = addresses[chainName];
        expect(
          chainAddresses,
          `Output for chain ${chainName} should be an object`,
        ).to.be.an('object');
        expect(
          chainAddresses[tokenType],
          `${tokenType} address for ${chainName} should match configuration`,
        ).to.equal(addressOrDenom);
      } else {
        throw new Error(`Address output missing expected chain: ${chainName}`);
      }
    });
  }
}

describe('hyperlane warp addresses e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const warpRouteConfig1 = {
    tokens: [
      {
        addressOrDenom: '0x0000000000000000000000000000000000000001',
        chainName: 'anvil',
        standard: 'EvmHypNative',
        symbol: 'TST',
      },
      {
        addressOrDenom: '0x0000000000000000000000000000000000000002',
        chainName: 'anvil2',
        standard: 'EvmHypSynthetic',
        symbol: 'TST',
      },
      {
        addressOrDenom: '0x0000000000000000000000000000000000000003',
        chainName: 'anvil3',
        standard: 'EvmHypSynthetic',
        symbol: 'TST',
      },
    ],
  } as WarpCoreConfig;

  const warpRouteConfig2 = {
    tokens: [
      {
        addressOrDenom: '0x0000000000000000000000000000000000000004',
        chainName: 'anvil',
        standard: 'EvmHypNative',
        symbol: 'TKN',
        decimals: 18,
        name: 'test',
      },
      {
        addressOrDenom: '0x0000000000000000000000000000000000000005',
        chainName: 'anvil2',
        standard: 'EvmHypSynthetic',
        symbol: 'TKN',
        decimals: 18,
        name: 'test',
      },
    ],
  } as WarpCoreConfig;

  let registry: IRegistry;

  before(async () => {
    ({ registry } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    }));
    registry.addWarpRoute(warpRouteConfig1);
    registry.addWarpRoute(warpRouteConfig2);
  });

  describe('hyperlane warp addresses --symbol command', function () {
    it('should display all addresses when selecting first warp route', async () => {
      const output = hyperlaneWarpAddresses({ symbol: 'TST' })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, [
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select from matching warp routes'),
          input: KeyBoardKeys.ENTER, // Select first option
        },
      ]);

      verifyAddressesMatchConfig(finalOutput, warpRouteConfig1);
    });

    it('should display correct addresses when navigating to second matching route', async () => {
      const output = hyperlaneWarpAddresses({ symbol: 'TKN' })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, [
        {
          check: (currentOutput: string) =>
            currentOutput.includes('Select from matching warp routes'),
          input: KeyBoardKeys.ENTER, // Select first option
        },
      ]);

      verifyAddressesMatchConfig(finalOutput, warpRouteConfig2);
    });

    it('should automatically select route when providing a unique symbol and chain combination', async () => {
      // Create a unique symbol that only exists on one route
      const uniqueWarpConfig = {
        tokens: [
          {
            addressOrDenom: '0x0000000000000000000000000000000000000006',
            chainName: 'anvil4',
            standard: 'EvmHypNative',
            symbol: 'UNQ',
          },
        ],
      } as WarpCoreConfig;

      registry.addWarpRoute(uniqueWarpConfig);

      const output = hyperlaneWarpAddresses({
        symbol: 'UNQ',
        chain: 'anvil4',
      })
        .stdio('pipe')
        .nothrow();

      // Should not need to handle prompts as it should auto-select the only matching route
      const finalOutput = await output;

      verifyAddressesMatchConfig(finalOutput, uniqueWarpConfig, 'anvil4');
    });
  });

  it('hyperlane warp addresses --warp ...', async () => {
    const token1 = warpRouteConfig2.tokens[0];
    const token2 = warpRouteConfig2.tokens[1];
    const warpIdentifier = `${REGISTRY_PATH}/deployments/warp_routes/${token1.symbol}/${token1.chainName}-${token2.chainName}-config.yaml`;
    console.log('warpIdentifier', warpIdentifier);
    const output = hyperlaneWarpAddresses({
      warp: warpIdentifier,
    })
      .stdio('pipe')
      .nothrow();

    // No need for prompt handling as --warp directly selects the route
    const finalOutput = await output;

    verifyAddressesMatchConfig(finalOutput, warpRouteConfig2);
  });
});
