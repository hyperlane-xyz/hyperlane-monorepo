# Middleware Contracts

## Interchain Accounts

An interchain account is a smart contract that is deployed on a remote chain and is controlled exclusively by the deploying local account.
Interchain accounts provide developers with a [transparent multicall API](./contracts/OwnableMulticall.sol) to remote smart contracts.
This avoids the need to deploy application specific smart contracts on remote chains while simultaneously enabling cross-chain composability.

See [IBC Interchain Accounts](https://github.com/cosmos/ibc/blob/main/spec/app/ics-027-interchain-accounts/README.md) for the Cosmos ecosystem equivalent.

## Interchain Query System

TBD
