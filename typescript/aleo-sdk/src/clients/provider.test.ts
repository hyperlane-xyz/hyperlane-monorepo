import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { AleoProvider } from '../runtime/mainnet.js';
import { toAleoAddress } from '../utils/helper.crypto.js';
import { ALEO_NULL_ADDRESS, stringToU128 } from '../utils/helper.js';
import { AleoTokenType } from '../utils/types.js';
import { getSyntheticWarpTokenConfig } from '../warp/warp-query.js';

class TestAleoProvider extends AleoProvider {
  get networkClient() {
    return this.aleoClient;
  }
}

const cases = [
  { route: 'hyp_warp_token_usdt_v2.aleo', token: 'arc20_usdt.aleo' },
  { route: 'hyp_warp_token_usdg_v2.aleo', token: 'shield_arc22_usdg.aleo' },
  { route: 'hyp_warp_token_usdt_v3.aleo', token: 'shield_arc22_usdt.aleo' },
];

describe('Aleo ARC warp route reads', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const { route, token } of cases) {
    describe(route, () => {
      let provider: TestAleoProvider;
      let mappingReads: string[];

      beforeEach(() => {
        mappingReads = [];
        provider = new TestAleoProvider(['http://localhost:3030'], 0, {
          name: 'aleo',
          chainId: 0,
          domainId: 1,
          protocol: ProtocolType.Aleo,
          rpcUrls: [{ http: 'http://localhost:3030' }],
        });
        provider.networkClient.getProgramImportNames = async () => [
          'hyp_mailbox.aleo',
          'hyp_dispatch_proxy.aleo',
          'hyp_multisig_core.aleo',
          'shield_arc22_freezelist.aleo',
          token,
          ...(route.endsWith('_v3.aleo')
            ? [
                'hyp_warp_token_usdt_v2.aleo',
                'arc20_usdt.aleo',
                'arc20_multisig_core.aleo',
              ]
            : []),
        ];
        provider.networkClient.getProgram = async () =>
          `    call ${token}/burn_public self.caller r0 into r1;`;
        provider.networkClient.getProgramMappingValue = async (
          programId,
          mapping,
        ) => {
          mappingReads.push(`${programId}/${mapping}`);
          if (mapping === 'app_metadata') {
            return `{
              token_type: 1u8,
              token_owner: ${ALEO_NULL_ADDRESS},
              ism: ${ALEO_NULL_ADDRESS},
              hook: ${ALEO_NULL_ADDRESS},
              token_id: 123field,
              local_decimals: 6u8,
              remote_decimals: 18u8
            }`;
          }
          if (mapping === 'remote_router_length') return '0u32';
          // Return distinct legacy metadata so an incorrect registry fallback
          // fails the assertions immediately without network retries.
          return `{
            name: ${stringToU128('Legacy')}u128,
            symbol: ${stringToU128('OLD')}u128,
            decimals: 9u8,
            supply: 1u128
          }`;
        };
        globalThis.fetch = async (input) => {
          const url = String(input);
          expect(url).to.contain(`/program/${token}/view/`);
          const outputs: Record<string, string> = {
            name: "'Tether_USD'",
            symbol: "'USDT'",
            decimals: '6u8',
            supply: '9000000u128',
            balance_of: '2000000u128',
          };
          return Response.json([outputs[url.split('/').pop() ?? '']]);
        };
      });

      afterEach(() => {
        expect(
          mappingReads.some((read) => read.startsWith('token_registry.aleo/')),
        ).to.equal(false);
      });

      it('resolves the token denom and metadata for CLI deployment output', async () => {
        const result = await provider.getToken({
          tokenAddress: toAleoAddress(route),
        });
        expect(result).to.include({
          denom: token,
          name: 'Tether_USD',
          symbol: 'USDT',
          decimals: 6,
        });
        expect(
          await provider.getBalance({
            address: ALEO_NULL_ADDRESS,
            denom: result.denom,
          }),
        ).to.equal(2000000n);
      });

      it('reads bridged supply from the ARC token', async () => {
        expect(
          await provider.getBridgedSupply({
            tokenAddress: toAleoAddress(route),
          }),
        ).to.equal(9000000n);
      });

      it('reads synthetic deployment configuration with decimal scaling', async () => {
        const config = await getSyntheticWarpTokenConfig(
          provider.networkClient,
          toAleoAddress(route),
          'hyp_ism_manager.aleo',
          'hyp_hook_manager.aleo',
        );
        expect(config).to.include({
          type: AleoTokenType.SYNTHETIC,
          name: 'Tether_USD',
          symbol: 'USDT',
          decimals: 6,
          scale: 1e12,
        });
      });
    });
  }
});
