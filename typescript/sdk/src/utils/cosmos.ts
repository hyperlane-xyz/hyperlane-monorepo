import { z } from 'zod';

// Generated from https://github.com/cosmos/chain-registry/blob/master/chain.schema.json
// using https://stefanterdell.github.io/json-schema-to-zod-react/
export const CosmosChainSchema = z.object({
  $schema: z
    .string()
    .regex(new RegExp('^(\\.\\./)+chain\\.schema\\.json$'))
    .min(1)
    .optional(),
  chain_name: z.string().regex(new RegExp('[a-z0-9]+')).min(1),
  chain_type: z
    .enum([
      'cosmos',
      'eip155',
      'bip122',
      'polkadot',
      'solana',
      'algorand',
      'arweave',
      'ergo',
      'fil',
      'hedera',
      'monero',
      'reef',
      'stacks',
      'starknet',
      'stellar',
      'tezos',
      'vechain',
      'waves',
      'xrpl',
      'unknown',
    ])
    .describe(
      "The 'type' of chain as the corresponding CAIP-2 Namespace value. E.G., 'cosmos' or 'eip155'. Namespaces can be found here: https://github.com/ChainAgnostic/namespaces/tree/main.",
    ),
  chain_id: z.string().min(1).optional(),
  pre_fork_chain_name: z
    .string()
    .regex(new RegExp('[a-z0-9]+'))
    .min(1)
    .optional(),
  pretty_name: z.string().min(1).optional(),
  website: z.url().min(1).optional(),
  status: z.enum(['live', 'upcoming', 'killed']).optional(),
  network_type: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  bech32_prefix: z
    .string()
    .min(1)
    .describe(
      "The default prefix for the human-readable part of addresses that identifies the coin type. Must be registered with SLIP-0173. E.g., 'cosmos'",
    )
    .optional(),
  bech32_config: z
    .strictObject({
      bech32PrefixAccAddr: z
        .string()
        .min(1)
        .describe("e.g., 'cosmos'")
        .optional(),
      bech32PrefixAccPub: z
        .string()
        .min(1)
        .describe("e.g., 'cosmospub'")
        .optional(),
      bech32PrefixValAddr: z
        .string()
        .min(1)
        .describe("e.g., 'cosmosvaloper'")
        .optional(),
      bech32PrefixValPub: z
        .string()
        .min(1)
        .describe("e.g., 'cosmosvaloperpub'")
        .optional(),
      bech32PrefixConsAddr: z
        .string()
        .min(1)
        .describe("e.g., 'cosmosvalcons'")
        .optional(),
      bech32PrefixConsPub: z
        .string()
        .min(1)
        .describe("e.g., 'cosmosvalconspub'")
        .optional(),
    })
    .describe('Used to override the bech32_prefix for specific uses.')
    .optional(),
  daemon_name: z.string().min(1).optional(),
  node_home: z.string().min(1).optional(),
  key_algos: z
    .array(z.enum(['secp256k1', 'ethsecp256k1', 'ed25519', 'sr25519', 'bn254']))
    .optional(),
  slip44: z.number().optional(),
  alternative_slip44s: z.array(z.number()).optional(),
  fees: z
    .strictObject({
      fee_tokens: z.array(
        z.strictObject({
          denom: z.string().min(1),
          fixed_min_gas_price: z.number().optional(),
          low_gas_price: z.number().optional(),
          average_gas_price: z.number().optional(),
          high_gas_price: z.number().optional(),
          gas_costs: z
            .strictObject({
              cosmos_send: z.number().optional(),
              ibc_transfer: z.number().optional(),
            })
            .optional(),
        }),
      ),
    })
    .optional(),
  staking: z
    .strictObject({
      staking_tokens: z.array(z.strictObject({ denom: z.string().min(1) })),
      lock_duration: z
        .strictObject({
          blocks: z
            .number()
            .describe(
              'The number of blocks for which the staked tokens are locked.',
            )
            .optional(),
          time: z
            .string()
            .min(1)
            .describe(
              'The approximate time for which the staked tokens are locked.',
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  codebase: z
    .strictObject({
      git_repo: z.url().min(1).optional(),
      recommended_version: z.string().min(1).optional(),
      compatible_versions: z.array(z.string().min(1)).optional(),
      tag: z
        .string()
        .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
        .min(1)
        .describe('Git Upgrade Tag')
        .optional(),
      language: z
        .strictObject({
          type: z.enum(['go', 'rust', 'solidity', 'other']),
          version: z
            .string()
            .regex(new RegExp('^v?\\d+(\\.\\d+){0,2}$'))
            .min(1)
            .describe("Simple version string (e.g., 'v1.0.0').")
            .optional(),
          repo: z
            .string()
            .url()
            .min(1)
            .describe('URL of the code repository.')
            .optional(),
          tag: z
            .string()
            .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
            .min(1)
            .describe('Git Upgrade Tag')
            .optional(),
        })
        .optional(),
      binaries: z
        .strictObject({
          'linux/amd64': z.url().min(1).optional(),
          'linux/arm64': z.url().min(1).optional(),
          'darwin/amd64': z.url().min(1).optional(),
          'darwin/arm64': z.url().min(1).optional(),
          'windows/amd64': z.url().min(1).optional(),
          'windows/arm64': z.url().min(1).optional(),
        })
        .optional(),
      sdk: z
        .strictObject({
          type: z.enum(['cosmos', 'penumbra', 'other']),
          version: z
            .string()
            .regex(new RegExp('^v?\\d+(\\.\\d+){0,2}$'))
            .min(1)
            .describe("Simple version string (e.g., 'v1.0.0').")
            .optional(),
          repo: z
            .string()
            .url()
            .min(1)
            .describe('URL of the code repository.')
            .optional(),
          tag: z
            .string()
            .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
            .min(1)
            .describe('Git Upgrade Tag')
            .optional(),
        })
        .optional(),
      consensus: z
        .strictObject({
          type: z.enum(['tendermint', 'cometbft', 'sei-tendermint']),
          version: z
            .string()
            .regex(new RegExp('^v?\\d+(\\.\\d+){0,2}$'))
            .min(1)
            .describe("Simple version string (e.g., 'v1.0.0').")
            .optional(),
          repo: z
            .string()
            .url()
            .min(1)
            .describe('URL of the code repository.')
            .optional(),
          tag: z
            .string()
            .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
            .min(1)
            .describe('Git Upgrade Tag')
            .optional(),
        })
        .optional(),
      cosmwasm: z
        .strictObject({
          version: z
            .string()
            .regex(new RegExp('^v?\\d+(\\.\\d+){0,2}$'))
            .min(1)
            .describe("Simple version string (e.g., 'v1.0.0').")
            .optional(),
          repo: z
            .string()
            .url()
            .min(1)
            .describe('URL of the code repository.')
            .optional(),
          tag: z
            .string()
            .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
            .min(1)
            .describe('Git Upgrade Tag')
            .optional(),
          enabled: z.boolean().optional(),
          path: z
            .string()
            .regex(new RegExp('^\\$HOME.*$'))
            .min(1)
            .describe(
              'Relative path to the cosmwasm directory. ex. $HOME/.juno/data/wasm',
            )
            .optional(),
        })
        .optional(),
      ibc: z
        .strictObject({
          type: z.enum(['go', 'rust', 'other']),
          version: z
            .string()
            .regex(new RegExp('^v?\\d+(\\.\\d+){0,2}$'))
            .min(1)
            .describe("Simple version string (e.g., 'v1.0.0').")
            .optional(),
          repo: z
            .string()
            .url()
            .min(1)
            .describe('URL of the code repository.')
            .optional(),
          tag: z
            .string()
            .regex(new RegExp('^[A-Za-z0-9._/@-]+$'))
            .min(1)
            .describe('Git Upgrade Tag')
            .optional(),
          ics_enabled: z
            .array(
              z
                .enum(['ics20-1', 'ics27-1', 'mauth'])
                .describe('IBC app or ICS standard.'),
            )
            .describe(
              'List of IBC apps (usually corresponding to a ICS standard) which have been enabled on the network.',
            )
            .optional(),
        })
        .optional(),
      genesis: z
        .strictObject({
          name: z.string().min(1).optional(),
          genesis_url: z.url().min(1),
          ics_ccv_url: z.url().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  images: z
    .array(
      z
        .strictObject({
          image_sync: z
            .strictObject({
              chain_name: z
                .string()
                .min(1)
                .describe(
                  "The chain name or platform from which the object resides. E.g., 'cosmoshub', 'ethereum', 'forex', or 'nasdaq'",
                ),
              base_denom: z
                .string()
                .min(1)
                .describe(
                  "The base denom of the asset from which the object originates. E.g., when describing ATOM from Cosmos Hub, specify 'uatom', NOT 'atom' nor 'ATOM'; base units are unique per platform.",
                )
                .optional(),
            })
            .describe(
              'The (primary) key used to identify an object within the Chain Registry.',
            )
            .optional(),
          png: z
            .string()
            .regex(
              new RegExp(
                '^https://raw\\.githubusercontent\\.com/cosmos/chain-registry/master/(|testnets/|_non-cosmos/)[a-z0-9]+/images/.+\\.png$',
              ),
            )
            .min(1)
            .optional(),
          svg: z
            .string()
            .regex(
              new RegExp(
                '^https://raw\\.githubusercontent\\.com/cosmos/chain-registry/master/(|testnets/|_non-cosmos/)[a-z0-9]+/images/.+\\.svg$',
              ),
            )
            .min(1)
            .optional(),
          theme: z
            .strictObject({
              circle: z.boolean().optional(),
              dark_mode: z.boolean().optional(),
              monochrome: z.boolean().optional(),
            })
            .optional(),
        })
        .and(z.union([z.any(), z.any()])),
    )
    .optional(),
  logo_URIs: z
    .strictObject({
      png: z
        .string()
        .regex(
          new RegExp(
            '^https://raw\\.githubusercontent\\.com/cosmos/chain-registry/master/(|testnets/|_non-cosmos/)[a-z0-9]+/images/.+\\.png$',
          ),
        )
        .min(1)
        .optional(),
      svg: z
        .string()
        .regex(
          new RegExp(
            '^https://raw\\.githubusercontent\\.com/cosmos/chain-registry/master/(|testnets/|_non-cosmos/)[a-z0-9]+/images/.+\\.svg$',
          ),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  description: z.string().min(1).max(3000).optional(),
  peers: z
    .strictObject({
      seeds: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
          }),
        )
        .optional(),
      persistent_peers: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  apis: z
    .strictObject({
      rpc: z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
      rest: z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
      grpc: z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
      wss: z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
      'grpc-web': z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
      'evm-http-jsonrpc': z
        .array(
          z.strictObject({
            address: z.string().min(1),
            provider: z.string().min(1).optional(),
            archive: z.boolean().default(false),
          }),
        )
        .optional(),
    })
    .optional(),
  explorers: z
    .array(
      z.strictObject({
        kind: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
        tx_page: z.string().min(1).optional(),
        account_page: z.string().min(1).optional(),
        validator_page: z.string().min(1).optional(),
        proposal_page: z.string().min(1).optional(),
        block_page: z.string().min(1).optional(),
      }),
    )
    .optional(),
  keywords: z.array(z.string().min(1)).optional(),
  extra_codecs: z.array(z.enum(['ethermint', 'injective'])).optional(),
});
export async function getCosmosRegistryChain(chain: string) {
  const json = await fetch(
    `https://raw.githubusercontent.com/cosmos/chain-registry/master/${chain}/chain.json`,
  );
  const data = await json.json();
  const result = CosmosChainSchema.safeParse(data);
  if (!result.success) {
    const errorMessages = result.error.issues.map(
      (issue) => `${issue.path} => ${issue.message}`,
    );
    throw new Error(
      `Invalid Cosmos chain ${chain}:\n ${errorMessages.join('\n')}`,
    );
  }
  return result.data;
}
