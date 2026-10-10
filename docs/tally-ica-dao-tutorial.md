# Use Hyperlane ICAs from a Tally DAO

This guide shows how a DAO that creates proposals through Tally can use a
Hyperlane Interchain Account (ICA) to control assets on a remote EVM chain.
The flow is:

1. Find the deterministic ICA address that belongs to the DAO on the remote
   chain.
2. Fund that remote ICA.
3. Create a Tally proposal on the DAO's local chain that calls the Hyperlane
   `InterchainAccountRouter`.

## Prerequisites

- A Tally DAO on an EVM chain with executable proposals.
- The address that actually executes successful proposals. For many DAOs this
  is a timelock contract, not the Governor contract and not the proposer EOA.
- Hyperlane ICA routers deployed on the local and remote chains. Use the
  canonical Hyperlane registry or the deployment address reference to find the
  `interchainAccountRouter` for each chain.
- Native tokens on the local chain to pay for Hyperlane message delivery.
- The ABI of the remote contract that the DAO's ICA will call.

Throughout the examples:

```text
LOCAL_CHAIN        = ethereum
LOCAL_DOMAIN       = 1
REMOTE_CHAIN       = arbitrum
REMOTE_DOMAIN      = 42161
DAO_EXECUTOR       = 0x...  # timelock or executor that Tally will call from
LOCAL_ICA_ROUTER   = 0x...  # InterchainAccountRouter on LOCAL_CHAIN
REMOTE_TARGET      = 0x...  # contract on REMOTE_CHAIN to be called by the ICA
```

## 1. Find the DAO's remote ICA address

An ICA is keyed by the origin domain, owner, origin router, destination router,
destination ISM, and optional salt. For the common default-router case, the
origin router exposes a convenience function:

```solidity
function getRemoteInterchainAccount(
    uint32 destination,
    address owner
) external view returns (address);
```

For a DAO proposal, `owner` must be the address that will call the local ICA
router when the proposal executes. In most Tally setups that means the DAO
timelock or executor. If you use a proposer wallet here, you will derive the
wrong account.

Query the local router:

```bash
cast call $LOCAL_ICA_ROUTER \
  "getRemoteInterchainAccount(uint32,address)(address)" \
  $REMOTE_DOMAIN \
  $DAO_EXECUTOR \
  --rpc-url $LOCAL_RPC_URL
```

The returned address is the DAO's ICA on `REMOTE_CHAIN`. It is deterministic and
can receive funds before it has code deployed. If you want to deploy the account
before funding it, use the CLI:

```bash
npx @hyperlane-xyz/cli ica deploy \
  --origin $LOCAL_CHAIN \
  --chains $REMOTE_CHAIN \
  --owner $DAO_EXECUTOR
```

## 2. Fund the remote ICA

Send the assets the DAO needs to control to the ICA address on the remote chain.
Examples:

- Send remote-chain native gas token if the ICA needs to forward native value in
  a call.
- Send ERC-20 tokens if the ICA will transfer, approve, deposit, or bridge that
  token.
- Keep delivery gas separate: the local DAO proposal also needs native value on
  the local chain to pay Hyperlane relayers.

After funding, verify the remote balance on the destination block explorer. The
ICA may still show as an address with no contract code until the first remote
call is delivered.

## 3. Encode the remote action

Each ICA remote action is a `CallLib.Call` tuple:

```solidity
struct Call {
    bytes32 to;
    uint256 value;
    bytes data;
}
```

For an EVM target, left-pad the target address to `bytes32`:

```text
to = 0x000000000000000000000000 + REMOTE_TARGET without its 0x prefix
```

Example: encode an ERC-20 transfer that will be executed by the DAO's remote
ICA:

```bash
TRANSFER_DATA=$(cast calldata \
  "transfer(address,uint256)" \
  0x1111111111111111111111111111111111111111 \
  1000000000000000000)
```

Then build the call tuple:

```text
[
  {
    to: 0x000000000000000000000000<REMOTE_TARGET_WITHOUT_0X>,
    value: 0,
    data: <TRANSFER_DATA>
  }
]
```

Use more than one tuple if the ICA should execute a batch.

## 4. Create the Tally custom action

In Tally, create a proposal and add a custom action:

```text
Target contract: LOCAL_ICA_ROUTER
Function: callRemote(uint32,(bytes32,uint256,bytes)[])
Value: Hyperlane delivery quote in local native token
Arguments:
  destination: REMOTE_DOMAIN
  calls: the CallLib.Call[] tuple array from step 3
```

Quote the native value before finalizing the executable action. For simple
messages, query the router:

```bash
cast call $LOCAL_ICA_ROUTER \
  "quoteGasPayment(uint32)(uint256)" \
  $REMOTE_DOMAIN \
  --rpc-url $LOCAL_RPC_URL
```

For calls that need an explicit gas limit, use the gas-limit overload:

```bash
cast call $LOCAL_ICA_ROUTER \
  "quoteGasPayment(uint32,uint256)(uint256)" \
  $REMOTE_DOMAIN \
  $REMOTE_EXECUTION_GAS_LIMIT \
  --rpc-url $LOCAL_RPC_URL
```

Use the returned amount as the proposal action value, with a buffer if the
proposal will be executed later and gas prices may move. Tally supports sending
native value with executable proposal actions, so the value belongs on the
custom action that targets `LOCAL_ICA_ROUTER`.

When the proposal executes, the DAO executor calls `callRemote`. Hyperlane emits
the interchain message on the local chain, the relayer delivers it on the remote
chain, and the remote router executes the encoded calls from the DAO's ICA.

## Validation checklist

- The `owner` used to derive the ICA equals the proposal executor that will call
  the router.
- The remote ICA address has the token/native balance required by the remote
  action.
- The local proposal action includes enough native value for Hyperlane delivery.
- The `to` value in each `CallLib.Call` is a left-padded `bytes32` target
  address.
- The remote calldata was generated from the ABI of the remote target contract.
- A small test transfer or no-op call succeeds before moving large treasury
  amounts.
- After execution, check both the local dispatch transaction and the remote
  `Mailbox.process` transaction in Hyperlane Explorer or the relevant block
  explorers.

## Common mistakes

- Deriving the ICA with the Governor address when the DAO uses a Timelock as the
  proposal executor.
- Funding the origin chain only. The remote ICA must hold assets it needs to
  spend on the remote chain.
- Forgetting that remote calls are sent from the ICA address, so remote
  protocols must grant permissions or approvals to that ICA.
- Underpaying delivery gas in the Tally action value.
- Reusing calldata from the local chain when the remote target has a different
  address, ABI, or token decimal setup.

## References

- Hyperlane Interchain Accounts overview:
  https://docs.hyperlane.xyz/docs/applications/interchain-account/overview
- Hyperlane ICA example usage:
  https://docs.hyperlane.xyz/docs/applications/interchain-account/example-usage
- Hyperlane ICA router deployment addresses:
  https://docs.hyperlane.xyz/docs/reference/addresses/deployments/interchainAccountRouter
- Tally custom actions:
  https://docs.tally.xyz/knowledge-base/proposals/creating-proposals/custom-actions
