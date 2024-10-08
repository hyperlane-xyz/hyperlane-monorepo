# Middleware Contracts

## Interchain Accounts

An interchain account is a smart contract that is deployed on a remote chain controlled exclusively by the origin chain's deployer account.
Interchain accounts provide developers with a [transparent multicall API](../OwnableMulticall.sol) to remote smart contracts.
This avoids the need to deploy application specific smart contracts on remote chains while simultaneously enabling cross-chain composability.

See [IBC Interchain Accounts](https://github.com/cosmos/ibc/blob/main/spec/app/ics-027-interchain-accounts/README.md) for the Cosmos ecosystem equivalent.

## Interchain Query System

The interchain query system generalizes view calls to contracts on remote chains. It is a [transparent multicall API](../OwnableMulticall.sol) that can be used to query remote smart contracts. This avoids the need to deploy application specific smart contracts on remote chains while simultaneously enabling cross-chain composability.

See [IBC Interchain Query System](https://github.com/cosmos/ibc/tree/main/spec/app/ics-031-crosschain-queries) for the Cosmos ecosystem equivalent.
