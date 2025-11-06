# Validator instructions for HL based bridges between Dymension <-> Other chains

Dymension has bridges between

- Kaspa <-> Dymension
- Ethereum <-> Dymension
- Solana <-> Dymension
- (soon) Base <-> Dymension
- (soon) Binance <-> Dymension

There are two distinct technologies:

1. Custom HL based bridge between Kaspa <-> Dymension
2. Vanilla HL bridge between the other chains and Dymension

A 'validator' actor can 

1. Validate the Kaspa <-> Dymension bridge
2. Validate Dymension chain, for purposes of minting tokens on Ethereum/Solana/Base/Binance

These are two DISTINCT activities and not related at all.

## Kaspa <-> Dymension

N validators are needed. Each validator is responsible for TWO things

1. Mint wKAS on Dymension
2. Spend escrowed KAS on Kaspa

This requires exactly TWO key pairs. The first is an Ethereum _type_ key, used to sign a multisig processed by Dymension chain logic. The second is a Kaspa key, used to sign a multisig processed by Kaspa network. The first key can be generated inside AWS KMS. The second key can be securely generated and used by a combination of KMS and Secret Manager.

Both keys must be very secure because they control funds.

See [../kaspa/../VALIDATOR.md](./libs/kaspa/ops/validator/VALIDATOR.md) for full instructions on validating Kaspa <-> Dymension bridge.

## Ethereum/Solana/Base/Binance <-> Dymension

Vanilla HL tech works by having 'validators' observe merkle roots on a SINGLE chain. Therefore for the bridges, there are FIVE different sets of validators.

1. Dymension
2. Ethereum
3. Solana
4. Base
5. Binance

The validator sets for Ethereum/Solana/Base/Binance are large and already exist. We will choose a secure subset to process inbound messages from these chains on Dymension.

For Blumbus, Dymension team and partners will run N validators for Dymension Blumbus chain; each validator is responsible for TWO things

1. Observing Dymension chain HL mailbox entity merkle root, and signing a digest for it and posting the digest to a public S3 bucket
2. Announcing the S3 bucket path on Dymension chain state in a bookkeeping entity

This requires exactly TWO key pairs. The first is an _Ethereum type_ key, used to sign the merkle root digests. The second is a Cosmos-SDK key, used to sign a one-time transaction (or more if needing to update later) to announce the S3 bucket path.

The first key must be very secure, it controls funds. The second key is not so important: if it is leaked, funds are not at risk.

HL already has comprehensive docs on setting up this kind of validator

- [HL doc run validators](https://docs.hyperlane.xyz/docs/operate/validators/run-validators)


## Addendum: practical setup

For Blumbus, each of our real life operators will run BOTH types of validator.