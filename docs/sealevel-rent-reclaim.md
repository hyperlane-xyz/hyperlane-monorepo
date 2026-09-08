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

- Mailbox: `SealevelCoreAdapter.createClaimProtocolFeesInstruction(mailboxProgramId, beneficiary)`
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
