# Solana Program Test Debugging Checklist (especially for CPIs & PDAs)

This checklist helps diagnose common issues when working with `solana-program-test` and testing on-chain programs, particularly those involving Cross-Program Invocations (CPIs) and Program Derived Addresses (PDAs).

## 1. Understand the Error Type and Scope

- **`DeadlineExceeded`**:

  - Is a required program (the one being called or one it CPIs to) missing from `ProgramTest::add_program()`?
  - Is an account being passed with incorrect flags (e.g., an executable program account marked as writable)?
  - Is there an infinite loop in on-chain code? (Less common for typical timeouts).
  - Is the `solana-program-test` environment simply too slow for a complex transaction? (Consider simplifying the test or transaction if possible).

- **`TransactionError(InstructionError(X, ErrorCode))`**:

  - `X`: Identifies which instruction in the transaction failed (0-indexed).
  - `ErrorCode`: Critical for diagnosis (e.g., `InvalidArgument`, `MissingRequiredSignature`, `UninitializedAccount`, `AccountAlreadyInitialized`, `BorshIoError`, custom program error).
  - **Origin**:
    - Check Solana program logs: `Program <ID> failed: <reason>`. This identifies the program that returned the error.
    - If it's your primary test program, the error is in its direct logic.
    - If it's a _called program_ (via CPI), the error originated there, and your main program failed because the CPI failed.

- **`Assertion failed` in test code (e.g., `assert_eq!`)**:
  - The transaction likely succeeded on-chain, but the resulting state (account data) is not what your test expects.
  - Carefully compare `left` (actual, from chain) and `right` (expected, constructed in test) values.
  - For byte arrays (`Vec<u8>`, often from Borsh serialization):
    - Identify the _first differing byte_.
    - Map the index of this byte back to the fields of the serialized struct to pinpoint the mismatched field.

## 2. Verify Program Test Setup (`ProgramTest`)

- Ensure **all** on-chain programs involved in the test (directly called or CPI'd to) are added to the `ProgramTest` environment using `pt.add_program(...)`.
  - Provide the correct program name (for logging/identification).
  - Provide the correct on-chain Program ID.
  - Provide the correct processor function (e.g., `processor!(process_instruction)`).

## 3. Check Instruction Accounts (Client-Side vs. Processor-Side)

This is crucial for `InvalidArgument`, `MissingRequiredSignature`, and many other errors.

- **Processor-Side (On-Chain Program):**

  - Clearly document (e.g., in comments above the instruction handler) the expected accounts, their order, `signer` status, and `writable` status.
  - `next_account_info()`: Ensure it's called in the correct order and for the correct number of accounts.

- **Client-Side (Test Code):**
  - The `Vec<AccountMeta>` passed to `Instruction::new_with_bytes` or `Instruction::new_with_borsh` must precisely match the processor's expectations:
    - **Order**: Must be identical.
    - **Pubkeys**:
      - Are PDAs derived with the _exact same seeds_ (byte slices and order) and the _correct deriving program ID_ on both client and processor side?
      - Are fixed addresses (e.g., `system_program::id()`, specific token mints) correct?
    - **`is_signer`**:
      - `true` if the account must sign the transaction. Standard `Keypair`s used as signers.
      - For CPIs using `invoke_signed`, if a PDA is one of the signers, its `AccountMeta` in the CPI instruction must have `is_signer=true`.
    - **`is_writable`**:
      - `true` if the program needs to modify the account's lamports or data.
    - **`is_executable`**:
      - Program accounts (e.g., `spl_token::id()`, or your own program when it's _being called by another program via CPI_) are executable. In the `AccountMeta` list for an instruction that _calls_ an executable program, this program account should be marked `is_writable=false`. (e.g., `AccountMeta::new_readonly(program_to_call::id(), false)`).

## 4. Deep Dive into PDA Derivations

If `InvalidArgument` errors persist and PDA mismatches are suspected:

- **Seeds**: Verify byte-for-byte and order that seeds are identical in client-side derivation (`Pubkey::find_program_address`) and processor-side checks (again, `Pubkey::find_program_address`).
- **Deriving Program ID**: Ensure the same `program_id` is used for deriving the PDA on both sides.
- **`msg!` Debugging**: In the processor, add `msg!("Provided PDA: {:?}", provided_key); msg!("Expected PDA: {:?}", expected_key);` right before the PDA check. This will print the actual pubkeys to the Solana program logs in your test output, confirming if they match.

## 5. Cross-Program Invocation (CPI) Specifics

When your program calls another program (`invoke` or `invoke_signed`):

- **Accounts for CPI**: The `AccountInfo` slice and `AccountMeta` list passed to `invoke`/`invoke_signed` must _exactly_ match what the _target (called) program's instruction handler_ expects (as per its own Step 3). Treat the CPI as a new, self-contained instruction call.
- **Signer Seeds for `invoke_signed`**:
  - If your program is signing the CPI using one of its PDAs:
    - The PDA's `AccountInfo` must be in the `AccountInfo` slice passed to `invoke_signed`.
    - The corresponding `AccountMeta` for this PDA in the CPI's instruction must have `is_signer=true`.
    - The `signer_seeds` argument to `invoke_signed` must correctly re-derive this PDA's pubkey.
- **Error Propagation**: An error from the called program (e.g., Mailbox returning `ProgramError::InvalidArgument`) will cause `invoke_signed` to fail. This error often propagates up and might be reported as an error from your main program's instruction. Check logs to see which program ID ultimately logged the failure.

## 6. Borsh (De)Serialization Issues (`BorshIoError`)

This typically means an on-chain account's data does not match the struct type the program is trying to deserialize it into, or an account is too small for data being written.

- **Initialization State**: Was the account being read (deserialized) correctly initialized with a valid Borsh-serialized struct of the _exact expected type_? Check initialization logic (e.g., `Init` instruction handlers for PDAs).
- **Account Data Mismatch**: Are you accidentally passing the wrong account for a given deserialization attempt? For example, providing an "IGP Instance PDA" where the program expects the "Global IGP Program Data PDA". Both might be PDAs, but they store different data structures. (This was a key fix in our debug session).
- **Struct Definitions**: Ensure Rust struct definitions used for deserialization match the on-chain data layout precisely.
- **Account Size**: Ensure accounts are allocated with sufficient space for their data (e.g., during `create_pda_account`).

## 7. State Verification in Assertions (Test Code)

When `assert_eq!` or other assertions fail after a successful transaction:

- **Fetch Fresh Data**: Ensure you're fetching the latest account data from the `banks_client` _after_ the transaction has processed.
- **Deserialize Carefully**: Use the correct struct type for deserialization.
- **Construct Expected State Meticulously**:
  - **Nonces/Counts**: These often increment with each operation. Ensure your expected value reflects this.
  - **Timestamps/Slots**: These will vary with each test run. Either assert `actual.slot > 0`, compare against a value fetched from `TransactionStatus` if an exact match is needed, or don't assert them if not critical.
  - **Derived PDAs/Keys**: If the on-chain state includes PDAs or other derived keys, ensure your expected struct uses keys derived in the exact same way.
  - **CPI-Resultant Fields**: If a CPI to another program results in a field being set or modified (e.g., Mailbox setting `HyperlaneMessage::recipient` based on an enrolled router), the expected struct in your test must reflect the outcome of that CPI logic, not just the initial inputs to your program's instruction. (This was the fix for our `DispatchedMessage` assertion).
  - **Random vs. Determistic Values**: If your program uses random values internally that affect state, tests might become flaky. Prefer deterministic inputs or account for randomness if unavoidable.

## 8. Iterative Refinement & Logging

- **`msg!` Macro**: Use `msg!("Debug: My value = {:?}", my_value);` extensively in your on-chain Rust program code to trace execution flow, inspect variable values, and check account keys. This output appears in the "Solana Program Logs" section of `solana-program-test` output.
- **`println!` Macro (Test Code)**: Use `println!` in your Rust test code (`functional.rs`) to print variables, fetched account data, or intermediate states to your test console output.
- **One Change at a Time**: When debugging, try to make one isolated change and then re-run the test to observe its specific impact on the error or log output. This helps pinpoint cause and effect.
- **Read Logs Carefully**: Both the test output console (for `println!`, panics, and test status) and the Solana program logs (for `msg!`, program failures, and CPI traces) are invaluable.

By following this checklist, you can systematically approach debugging issues in your Solana programs and tests.
