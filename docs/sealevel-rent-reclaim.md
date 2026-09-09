# Sealevel rent reclamation

Mailbox outbox and IGP accounts already support permissionless claims to their
configured beneficiaries. Both programs use `Rent::get()?.minimum_balance(data_len)`
on the executing chain, so rent reductions require no new instruction or program
upgrade for these accounts. Different SVM chains can retain different rent settings;
no activation date or Solana-specific rent constant is used.

Claims transfer **all lamports above the current rent-exempt minimum**, including
accrued protocol fees or gas payments. This is not a calculation of historical rent
alone. The program retains the current minimum and validates the beneficiary.

## Build a claim

- Kit: `buildClaimProtocolFeesInstruction(mailboxProgramId, beneficiary)` from
  `@hyperlane-xyz/sealevel-sdk` returns an instruction for `SealevelSigner.send({ instructions: [claim] })`.
  It supports the signer's v0 default and explicitly enabled v1 configuration.
- Legacy SDK: `SealevelCoreAdapter.createClaimProtocolFeesInstruction(beneficiary)`
  builds an instruction for the derived outbox PDA. Supply the mailbox's configured
  protocol-fee beneficiary; another address is rejected on chain.
- IGP: `SealevelIgpAdapter.populateClaimTx(beneficiary)` builds an unsigned transaction
  and checks the beneficiary against the IGP account. The Rust Sealevel client's
  existing `igp claim` command also reads the configured beneficiary before claiming.

Instruction construction does not submit a transaction. Before submission, inspect
and simulate the transaction on the selected chain, including its beneficiary and
fee payer. A third party may pay the transaction fee; the beneficiary need not sign.
Repeated claims recover only newly available excess and still incur transaction fees.

For a preview, fetch the account's balance and data length and call that chain's
`getMinimumBalanceForRentExemption(dataLength)`. The preview is the nonnegative
difference between balance and minimum; execution recalculates rent on chain.

## Scope

These claims apply only to the mailbox outbox and IGP account. They do not reclaim
from inboxes, message accounts, other configuration PDAs, or warp collateral vaults.
Native warp vault balances include bridge backing and must not be swept as excess
rent. No balances are reclaimed automatically.

SPL Token and Token-2022 accounts use their own `WithdrawExcessLamports` instruction
and authority rules. Support depends on each SVM's deployed token programs, separately
from transaction-v1 support. This SDK addition does not implement token-account
reclamation or assume those instructions are available on every SVM.

## If the rent minimum increases again

A claim leaves the source at the current minimum. If the chain later restores a
higher minimum, subsequent claims fail with `AccountNotRentExempt` until the
account has enough lamports. Existing account data remains intact; accrued fees
first replenish the shortfall and only the excess becomes claimable.

1. Fetch the outbox or IGP account on the selected chain and note its data length
   and lamport balance. Verify the program, PDA and configured beneficiary.
2. Query `getMinimumBalanceForRentExemption(dataLength)` on that same chain.
   The top-up is `max(0, minimum - balance)` lamports; recheck immediately before
   sending because balances and rent settings can change.
3. Transfer that amount with the system program from a funded wallet to the
   source account. Keep transaction fees in the payer wallet. The top-up restores
   rent backing; it is not a payment to the beneficiary.
4. Confirm the transfer, fetch the balance and minimum again, then simulate the
   claim. Claim only when there is excess worth the transaction fee. A claim at
   exactly the minimum succeeds but transfers nothing.

This procedure covers the mailbox outbox and IGP only. It does not authorize
sweeping native warp collateral or topping up an unverified account.
