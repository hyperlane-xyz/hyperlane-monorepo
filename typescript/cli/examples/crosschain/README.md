# Cross-Chain Core Configs

These core configs are specifically designed for **cross-chain e2e tests** that involve multiple VM types (EVM, CosmosNative, Radix, Sealevel).

## Why separate configs?

The standard example configs (in `../cosmosnative/`, `../radix/`, etc.) are minimal and protocol-specific. Cross-VM warp route deployments require:

1. **IGP destination gas configs** for all remote chains - without these, `MsgEnrollRemoteRouter` fails on AltVMs because the remote domain isn't registered as "supported"
2. **Consistent hook types** across VMs for interoperability testing

These configs pre-register all test chains (`hyp1-3`, `anvil1-4`, `radix1-2`, `sealevel1`) in their IGP `oracleConfig` and `overhead` settings.

## Supported test chains

| Chain     | Protocol     | Domain ID  | Native Token Decimals |
| --------- | ------------ | ---------- | --------------------- |
| hyp1      | CosmosNative | 758986691  | 6                     |
| hyp2      | CosmosNative | 758986692  | 6                     |
| hyp3      | CosmosNative | 758986693  | 6                     |
| anvil1    | Ethereum     | 31337      | 18                    |
| anvil2    | Ethereum     | 31338      | 18                    |
| anvil3    | Ethereum     | 31347      | 18                    |
| anvil4    | Ethereum     | 31348      | 18                    |
| radix1    | Radix        | 1421493353 | 18                    |
| radix2    | Radix        | 1421493354 | 18                    |
| sealevel1 | Sealevel     | 1399811149 | 9                     |

## Usage

Cross-chain tests reference these configs via `CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL` in `src/tests/constants.ts`. To add a new cross-VM test, use these configs instead of the standard examples.
