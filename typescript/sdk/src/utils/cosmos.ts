import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

// Generated from https://github.com/cosmos/chain-registry/blob/master/chain.schema.json
// using https://stefanterdell.github.io/json-schema-to-zod-react/
export const CosmosChainSchema = z
  .object({
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
    website: z.string().url().min(1).optional(),
    update_link: z.string().url().min(1).optional(),
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
      .object({
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
      .strict()
      .describe('Used to override the bech32_prefix for specific uses.')
      .optional(),
    daemon_name: z.string().min(1).optional(),
    node_home: z.string().min(1).optional(),
    key_algos: z
      .array(
        z.enum(['secp256k1', 'ethsecp256k1', 'ed25519', 'sr25519', 'bn254']),
      )
      .optional(),
    slip44: z.number().optional(),
    alternative_slip44s: z.array(z.number()).optional(),
    fees: z
      .object({
        fee_tokens: z.array(
          z
            .object({
              denom: z.string().min(1),
              fixed_min_gas_price: z.number().optional(),
              low_gas_price: z.number().optional(),
              average_gas_price: z.number().optional(),
              high_gas_price: z.number().optional(),
              gas_costs: z
                .object({
                  cosmos_send: z.number().optional(),
                  ibc_transfer: z.number().optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    staking: z
      .object({
        staking_tokens: z.array(
          z.object({ denom: z.string().min(1) }).strict(),
        ),
        lock_duration: z
          .object({
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
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    codebase: z
      .object({
        git_repo: z.string().url().min(1).optional(),
        recommended_version: z.string().min(1).optional(),
        compatible_versions: z.array(z.string().min(1)).optional(),
        go_version: z
          .string()
          .regex(new RegExp('^[0-9]+\\.[0-9]+(\\.[0-9]+)?$'))
          .min(1)
          .describe('Minimum accepted go version to build the binary.')
          .optional(),
        language: z
          .object({
            type: z.enum(['go', 'rust', 'solidity', 'other']),
            version: z
              .string()
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
              .min(1)
              .describe(
                "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
              )
              .optional(),
          })
          .strict()
          .optional(),
        binaries: z
          .object({
            'linux/amd64': z.string().url().min(1).optional(),
            'linux/arm64': z.string().url().min(1).optional(),
            'darwin/amd64': z.string().url().min(1).optional(),
            'darwin/arm64': z.string().url().min(1).optional(),
            'windows/amd64': z.string().url().min(1).optional(),
            'windows/arm64': z.string().url().min(1).optional(),
          })
          .strict()
          .optional(),
        cosmos_sdk_version: z.string().min(1).optional(),
        sdk: z
          .object({
            type: z.enum(['cosmos', 'penumbra', 'other']),
            version: z
              .string()
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
              .min(1)
              .describe(
                "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
              )
              .optional(),
          })
          .strict()
          .optional(),
        consensus: z
          .object({
            type: z.enum(['tendermint', 'cometbft', 'sei-tendermint']),
            version: z
              .string()
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
              .min(1)
              .describe(
                "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
              )
              .optional(),
          })
          .strict()
          .optional(),
        cosmwasm_version: z.string().min(1).optional(),
        cosmwasm_enabled: z.boolean().optional(),
        cosmwasm_path: z
          .string()
          .regex(new RegExp('^\\$HOME.*$'))
          .min(1)
          .describe(
            'Relative path to the cosmwasm directory. ex. $HOME/.juno/data/wasm',
          )
          .optional(),
        cosmwasm: z
          .object({
            version: z
              .string()
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
              .min(1)
              .describe(
                "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
              )
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
          .strict()
          .optional(),
        ibc_go_version: z.string().min(1).optional(),
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
        ibc: z
          .object({
            type: z.enum(['go', 'rust', 'other']),
            version: z
              .string()
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
              .min(1)
              .describe(
                "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
              )
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
          .strict()
          .optional(),
        genesis: z
          .object({
            name: z.string().min(1).optional(),
            genesis_url: z.string().url().min(1),
            ics_ccv_url: z.string().url().min(1).optional(),
          })
          .strict()
          .optional(),
        versions: z
          .array(
            z
              .object({
                name: z.string().min(1).describe('Official Upgrade Name'),
                tag: z.string().min(1).describe('Git Upgrade Tag').optional(),
                height: z.number().describe('Block Height').optional(),
                proposal: z
                  .number()
                  .describe(
                    'Proposal that will officially signal community acceptance of the upgrade.',
                  )
                  .optional(),
                previous_version_name: z
                  .string()
                  .min(1)
                  .describe('[Optional] Name of the previous version')
                  .optional(),
                next_version_name: z
                  .string()
                  .min(0)
                  .describe('[Optional] Name of the following version')
                  .optional(),
                recommended_version: z.string().min(1).optional(),
                compatible_versions: z.array(z.string().min(1)).optional(),
                go_version: z
                  .string()
                  .regex(new RegExp('^[0-9]+\\.[0-9]+(\\.[0-9]+)?$'))
                  .min(1)
                  .describe('Minimum accepted go version to build the binary.')
                  .optional(),
                language: z
                  .object({
                    type: z.enum(['go', 'rust', 'solidity', 'other']),
                    version: z
                      .string()
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
                      .min(1)
                      .describe(
                        "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
                      )
                      .optional(),
                  })
                  .strict()
                  .optional(),
                cosmos_sdk_version: z.string().min(1).optional(),
                sdk: z
                  .object({
                    type: z.enum(['cosmos', 'penumbra', 'other']),
                    version: z
                      .string()
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
                      .min(1)
                      .describe(
                        "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
                      )
                      .optional(),
                  })
                  .strict()
                  .optional(),
                consensus: z
                  .object({
                    type: z.enum(['tendermint', 'cometbft', 'sei-tendermint']),
                    version: z
                      .string()
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
                      .min(1)
                      .describe(
                        "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
                      )
                      .optional(),
                  })
                  .strict()
                  .optional(),
                cosmwasm_version: z.string().min(1).optional(),
                cosmwasm_enabled: z.boolean().optional(),
                cosmwasm_path: z
                  .string()
                  .regex(new RegExp('^\\$HOME.*$'))
                  .min(1)
                  .describe(
                    'Relative path to the cosmwasm directory. ex. $HOME/.juno/data/wasm',
                  )
                  .optional(),
                cosmwasm: z
                  .object({
                    version: z
                      .string()
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
                      .min(1)
                      .describe(
                        "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
                      )
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
                  .strict()
                  .optional(),
                ibc_go_version: z.string().min(1).optional(),
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
                ibc: z
                  .object({
                    type: z.enum(['go', 'rust', 'other']),
                    version: z
                      .string()
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
                      .min(1)
                      .describe(
                        "Detailed version identifier (e.g., 'v1.0.0-a1s2f43g').",
                      )
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
                  .strict()
                  .optional(),
                binaries: z
                  .object({
                    'linux/amd64': z.string().url().min(1).optional(),
                    'linux/arm64': z.string().url().min(1).optional(),
                    'darwin/amd64': z.string().url().min(1).optional(),
                    'darwin/arm64': z.string().url().min(1).optional(),
                    'windows/amd64': z.string().url().min(1).optional(),
                    'windows/arm64': z.string().url().min(1).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    images: z
      .array(
        z
          .object({
            image_sync: z
              .object({
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
              .strict()
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
              .object({
                primary_color_hex: z
                  .string()
                  .regex(new RegExp('^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'))
                  .min(1)
                  .optional(),
                background_color_hex: z
                  .string()
                  .regex(
                    new RegExp('^(#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})|none)$'),
                  )
                  .min(1)
                  .optional(),
                circle: z.boolean().optional(),
                dark_mode: z.boolean().optional(),
                monochrome: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .and(z.union([z.any(), z.any()])),
      )
      .optional(),
    logo_URIs: z
      .object({
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
      .strict()
      .optional(),
    description: z.string().min(1).max(3000).optional(),
    peers: z
      .object({
        seeds: z
          .array(
            z
              .object({
                id: z.string().min(1),
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
        persistent_peers: z
          .array(
            z
              .object({
                id: z.string().min(1),
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    apis: z
      .object({
        rpc: z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
        rest: z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
        grpc: z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
        wss: z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
        'grpc-web': z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
        'evm-http-jsonrpc': z
          .array(
            z
              .object({
                address: z.string().min(1),
                provider: z.string().min(1).optional(),
                archive: z.boolean().default(false),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    explorers: z
      .array(
        z
          .object({
            kind: z.string().min(1).optional(),
            url: z.string().min(1).optional(),
            tx_page: z.string().min(1).optional(),
            account_page: z.string().min(1).optional(),
            validator_page: z.string().min(1).optional(),
            proposal_page: z.string().min(1).optional(),
            block_page: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    keywords: z.array(z.string().min(1)).optional(),
    extra_codecs: z.array(z.enum(['ethermint', 'injective'])).optional(),
  })
  .strict()
  .and(z.intersection(z.any(), z.any()))
  .describe(
    'Cosmos Chain.json is a metadata file that contains information about a cosmos sdk based chain.',
  );

// .strict().and(z.intersection(z.any(), z.any())) is similar to .passthrough()
// using this way as it's exactly as generated by the tool

export async function getCosmosRegistryChain(chain: string) {
  const json = await fetch(
    `https://raw.githubusercontent.com/cosmos/chain-registry/master/${chain}/chain.json`,
  );

  assert(
    json.status === 200,
    `Error getting Cosmos chain ${chain} from Cosmos registry: status code ${json.status}`,
  );

  const data = await json.json();
  const result = CosmosChainSchema.safeParse(data);
  if (!result.success) {
    const errorMessages = result.error.issues.map(
      (issue: any) => `${issue.path} => ${issue.message}`,
    );
    throw new Error(
      `Invalid Cosmos chain ${chain}:\n ${errorMessages.join('\n')}`,
    );
  }
  return result.data;
}
