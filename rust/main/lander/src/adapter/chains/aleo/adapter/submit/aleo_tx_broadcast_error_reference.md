# Transaction Broadcast Behavior (`/transaction/broadcast`)

Reference: [Aleo Transaction Broadcast Errors](https://gist.github.com/iamalwaysuncomfortable/d79660cd609be50866fef16b05cbcde2)

## Overview

The transaction broadcast endpoint can be hit with or without the `check_transaction` flag set to `true`.

The diagram below shows the flow of response codes when broadcasting to `/transaction/broadcast?check_transaction=true`

    /// POST /<network>/transaction/broadcast
    /// POST /<network>/transaction/broadcast?check_transaction={true}
    ///
    /// Transaction Broadcast Flow
    ///
    /// /transaction/broadcast
    ///         |
    ///    +----+---------------------------+
    ///    |                               |
    ///    v                               v
    /// Without Query Params        With Query Param
    ///                                check_transaction=true
    ///    |                               |
    ///    +---------+                     +---------+
    ///    |         |                     |         |
    ///    v         v                     v         v
    /// Synced   Not Synced            Synced   Not Synced
    ///    |         |                     |         |
    ///    v         v                     v         v
    ///   200       200        check_transaction  check_transaction
    ///                           +---------+        +---------+
    ///                           |         |        |         |
    ///                           v         v        v         v
    ///                          200   400/422/429  203       503

When calling `transaction/broadcast?check_transaction=true` you can expect the following behavior from the node.

---

## Node Sync Status

Each response will indicate whether the node is **Synced** or **Not Synced**:

- **Synced**:
  The node is synced to tip with the current state of the chain.
  For most of Provable's APIs, this is the path you will traverse most of the time.

- **Not Synced**:
  The node is still catching up and may not reflect the latest state of the chain.

---

## Case 1: `200 OK` Response

If you get a `200` response, this means the node has **accepted** the transaction.

After receiving a `200`, you can:

1. **Check the Unconfirmed Transaction**
   Call the **UnconfirmedTransaction** endpoint to see if the transaction has landed in the mempool, if you want to
   verify that it has truly landed after the `200` response.

2. **Check the Confirmed Transaction**
   Call the **ConfirmedTransaction** endpoint to see if the transaction has been accepted by the chain.

---

## Case 2: `400` / `422` / `429` / `503` Responses

These responses indicate that the transaction was **not** accepted, or could not be processed at this time.

---

### `400 Bad Request`

- **Message:** `"Transaction size exceeds the byte limit"`
  The transaction exceeded a **128-KBytes** limit (only possible if the inputs or outputs are too large; you will rarely
  hit this).

  **Action:**
  Ensure the transaction size is within the allowed limits and that inputs/outputs are not excessively large.

---

### `422 Unprocessable Entity` — Common Cases

These indicate that either something was wrong in the transaction JSON or some protocol requirement was not met.

- **Message:** `"Invalid Transaction Data"`
  The transaction request JSON was malformed.

  **Action:**
  Check that the transaction JSON is properly formed and includes all required fields.

---

- **Message:** `"Too many execution verifications in progress"`
  The node is currently verifying too many executions.

  **Action:**
  Retry after an interval.

---

- **Message:** `"Too many deploy verifications in progress"`
  The node is currently verifying too many deployments.

  **Action:**
  Retry after an interval.

---

- **Message:** `"Transaction '{}' is not well-formed: {error}"`
  The transaction structure was malformed or too large.

  **Action:**
  Check to ensure you're correctly building the transaction and that the software you built it with is on a recent SDK
  or SnarkVM dependency.

---

- **Message:** `"Transaction '{}' already exists in the ledger"`
  The transaction you submitted already exists in the ledger. This usually means you already sent this transaction and
  it has been included.

  **Action:**
  Confirm the transaction exists and is as expected via the **ConfirmedTransaction** endpoint.

---

- **Message:**
  `"Found a duplicate {Output ID/Input ID/commitment/nonce/serial_number} in the transaction"`

  This generally occurs when you've accidentally used a record input for a record that's already been spent.

  **Action:**
  Confirm the record you're using hasn't already been spent/used, and replace it with a record which hasn't yet been
  spent.

---

- **Message:** `"Incorrect transaction ID ({})"`
  The transaction ID is incorrect, which suggests it was potentially replaced.
  This edge case should never be hit by an honest client attempting to send a transaction.

  **Action:**
  Investigate how the transaction ID was derived or whether the transaction was modified or replaced.

---

### `429 Too Many Requests`

- **Message:** `"Too many requests"`
  The node is currently processing too many requests.

  **Action:**
  Retry after an interval.

---

### `503 Service Unavailable`

- **Message:** `"Unable to validate transaction (node is syncing)"`
  The node is syncing and cannot validate the transaction at this time.

  **Action:**
  Retry after an interval, or if possible, submit to a backup blockchain node.
