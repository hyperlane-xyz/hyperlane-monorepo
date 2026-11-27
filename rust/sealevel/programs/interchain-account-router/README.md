# Sealevel interchain account router

Minimal bidirectional ICA router. Authenticated incoming messages execute ordered
CPIs under a deterministic ICA authority inside the standard Hyperlane `Handle`
interface. Outgoing messages use the standard EVM ICA wire format.

## Wire format

```text
0x00 | owner: bytes32 | ism: bytes32 | salt: bytes32 | abi.encode(Call[])
Call = (bytes32 to, uint256 value, bytes data)
```

For EVM targets, `data` is ordinary EVM calldata and `value` is preserved unchanged.
For Sealevel targets, `to` is the program ID, `value` must be zero, and `data` is
Borsh-encoded `SealevelCallData`:

```text
accounts: Vec<{ pubkey: Pubkey, is_signer: bool, is_writable: bool }>
data: Vec<u8>  // native instruction bytes
```

The ordered account metas are inside the authenticated message. The relayer supplies
the corresponding accounts; it cannot substitute addresses or expand CPI privileges.
Only the ICA authority may be requested as a signer. SOL transfers use explicit
system-program instructions signed by that authority.

## Incoming calls

Initialize the router with `init_instruction`, signed by its current upgrade
authority. Initialization checks the canonical upgradeable-loader ProgramData
account, its owner, its state variant, and the authority signature. Initialize
before revoking upgrade authority. Configuration is immutable.

The router accepts `Handle` only from the configured mailbox's signed process
authority. As on EVM, the origin router need not be enrolled: its identity is part
of the ICA derivation, so different senders control different accounts.

`interchain_account_address` derives the authority under this router program using:

```text
["ica", origin.to_be_bytes(), owner, origin_router, ism, salt]
```

The PDA needs no allocation to sign CPIs. It can be funded to hold SOL, or set as
the owner/authority of other accounts. The derivation includes the same identity
fields as EVM; the resulting address is a Solana PDA, not an EVM CREATE2 address.

Delivery executes the calls immediately, following the Hyp token recipient pattern:

```text
Mailbox.process / InboxProcessFromAccount
  -> ISM verifies the message
  -> ICA.Handle authenticates the mailbox's process authority
  -> executes all calls, signing only for the derived ICA
  -> mailbox delivery completes
```

`HandleAccountMetas` returns the router config, ICA authority, and deduplicated
call accounts. The mailbox prepends its process authority. Writable flags are
merged for the outer instruction; each CPI uses the order and privileges encoded
in the authenticated message. Only the ICA may be requested as a CPI signer.

The mailbox provides replay protection. Any failed call rolls back the entire
batch and mailbox delivery, so the message can be retried. There is no separate
execution instruction or router execution-receipt PDA.

Small messages can use normal `InboxProcess` with inline message bytes; no buffer
is needed. Larger messages can use `InboxProcessFromAccount`. In that case, buffer
creation, upload, and cleanup remain the caller's responsibility. Both entrypoints
use the same ISM verification and `Handle` path; CPI, heap, and compute limits still
apply.

### No callbacks into the active mailbox

Incoming ICA calls must not call back into the mailbox processing the message,
including read-only calls. Solana rejects indirect reentrancy:

```text
Mailbox -> ICA.Handle -> Mailbox                         rejected
Mailbox -> ICA.Handle -> callRemote / transferRemote
                     -> Mailbox                         rejected
```

This restriction is enforced by the runtime, and failure rolls back the whole
delivery. Outbound `CallRemoteWithOverrides` remains available as an independent
instruction; incoming batches cannot use it to send replies through the active
mailbox. Local token transfers and governance calls that do not reenter the
mailbox are supported.

## Outgoing calls

Use `call_remote_with_overrides_instruction` with
`CallRemoteWithOverrides { destination, router, ism, calls, salt }`. The
destination router and ISM are explicit, matching EVM's `callRemoteWithOverrides`.
A zero destination router is rejected, as on EVM.
The owner comes from the signer account (wallet or calling program's PDA), never
from caller-controlled instruction data. `Call` and the cross-chain wire format
are unchanged.

Like Hyp token transfers, the transaction builder supplies a fresh unique-message
signer account separately from the instruction data. Pass its public key as
`unique_message` to `call_remote_with_overrides_instruction` and sign the
transaction with that keypair as well as the owner and payer. The unique signer
needs no funding or account allocation; the payer funds the mailbox's derived
message-storage PDA. Reusing the signer fails the mailbox's existing storage-account
check. The mailbox assigns the actual Hyperlane message nonce itself.

The router signs only with its normal dispatch-authority PDA during dispatch.
The Hyperlane message sender is the router program; the ICA message owner is the local signer.
The payer funds the normal mailbox fee and message storage. Return data is the
mailbox's message ID.

## Initial scope

- Incoming messages require `ism = 0` and use the mailbox default ISM. Nonzero ISMs
  are rejected, rather than ignored. Outgoing messages preserve the requested ISM.
- Only CALLS messages are supported; no commitments, reveals, or delegatecalls.
- Outbound calls are inline. No outbound buffer loading, automatic callbacks,
  router enrollment, gas-payment integration, or CLI/relayer changes.
- Existing transaction, CPI, account-meta return-data, heap, and compute limits apply.

## Validation

From `rust/sealevel`:

```sh
cargo test -p hyperlane-sealevel-interchain-account-router
cargo clippy -p hyperlane-sealevel-interchain-account-router --all-targets --no-deps -- -D warnings
cargo build-sbf --manifest-path programs/interchain-account-router/Cargo.toml
BPF_OUT_DIR=target/deploy cargo test -p hyperlane-sealevel-interchain-account-router --test functional
```

Setting `BPF_OUT_DIR` executes the compiled router; the test mailbox, ISM, and warp
program remain native. Tests cover the real native warp program's ISM/ownership
batch through both mailbox entrypoints, atomic rollback and retry, initialization
authorization, account privileges, mailbox replay protection, rejection of mailbox
callbacks, independent outbound dispatch, a buffered eight-transfer SOL batch,
and an independently generated ethers ABI fixture.
