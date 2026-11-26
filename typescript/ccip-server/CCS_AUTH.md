# CCS read authentication

Both CCS read APIs accept only EVM signatures from `CCS_AUTHORIZED_SIGNERS` (a nonempty
JSON array of Ethereum addresses). The same whitelist protects the EVM adapter and the
general EVM/SVM calldata API. Mainnet and testnet deployment values each include their
primary, RC, and fastpath relayer identities from `typescript/infra/config/relayer.json`.
A commitment's nonempty `relayers` list restricts access further; an empty list permits
any globally authorized signer.

The calldata lookup (GET) accepts only the packed (v1) signature of the SDK
`offchainLookupRequestMessageHash(sender, data, urlTemplate)`:

```
hash = keccak256(solidityPacked(
  [string, address, bytes, string],
  ["HYPERLANE_OFFCHAINLOOKUP", sender, data, urlTemplate]
))
signature = EIP-191-sign(hash bytes)
```

The EVM reveal lookup (POST) accepts only the framed (v2) signature of the SDK
`offchainLookupRequestHash({ urlTemplate, sender, callData, messageId, originTxHash, issuedAt })`:

```
hash = keccak256(abi.encode(
  bytes32 keccak256("HYPERLANE_OFFCHAINLOOKUP_V2"),
  bytes32 keccak256(bytes(urlTemplate)),
  address sender,
  bytes32 keccak256(data),
  bytes32 messageId,
  bytes32 keccak256(originTxHash),  // origin_tx_hash bytes
  uint64  issuedAt                  // unix seconds
))
signature = EIP-191-sign(hash bytes)
```

A v1 signature has no timestamp, nonce, or session: it can be reused for the same signed
payload and URL until the signer is removed from the whitelist. A v2 signature is accepted
only while `issuedAt` is at most `CCS_AUTH_MAX_AGE_SECONDS` old (decimal seconds from 10
to 120, default 30) and at most 5 seconds ahead of the server clock. There are no Solana
signatures. Use HTTPS and avoid logging signatures. Protected responses use `Cache-Control: no-store`.

## Existing EVM lookup

`POST /callCommitments/getCallsFromRevealMessage` takes this JSON body:

```json
{
  "sender": "0x<ISM contract address>",
  "data": "0x<ABI lookup calldata>",
  "signature": "0x<65-byte EVM signature>",
  "origin_tx_hash": "0x<32-byte hash of the tx that dispatched the reveal>",
  "message_id": "0x<32-byte id of the reveal message>",
  "issued_at": 1700000000
}
```

The body must carry a v2 signature: it requires `message_id`, an integer `issued_at`, and
a non-empty hex `origin_tx_hash`. A body without these fields (including one signed with
v1), or a malformed, expired, or future-dated one, returns 401, whichever signer signed it. With a valid
signature, a `message_id` that is not the id of the reveal message in `data` returns 403.

The signed URL is the configured public endpoint URL, including
`/callCommitments/getCallsFromRevealMessage`. Relayers take `message_id` from the message
they deliver, and `origin_tx_hash` from the transaction that dispatched it. The handler
uses only the signed `origin_tx_hash`, and an EVM reveal's calls are resolved from the
commitment dispatched alongside it (see the ccip-server README).

The reveal lookup derives the account from the commit's owner and user salt. A contract
that commits on a user's behalf must therefore derive the commit's user salt from its own
caller (`msg.sender`).

With a zero commit ISM, the reveal lookup skips re-deriving the dispatched router pair,
because registry ICA routers enroll no ISM (`isms(origin) == 0`). If a non-zero ISM is
ever enrolled on a registry ICA router (`enrollRemoteRouterAndIsm`), this skip in
`deriveRouterVersionIcas` (`CallCommitmentsService.ts`) must be revisited; otherwise
registrations made without an ISM on that pair stop resolving.

Origin binding differs by protocol. EVM-origin reveals must carry a 32-byte dispatch
`origin_tx_hash` (HTTP 400 for other signed lengths), and are served only when the ICA derived from that
receipt matches the stored ICA or a registry router version candidate (HTTP 403
otherwise). Sealevel-origin reveals are not served (HTTP 403) unless
`CCS_SEALEVEL_REVEALS_ENABLED=true`, which is off by default; when enabled, they are
served from the stored commitment record with no origin binding: access rests on relayer
authorization and the stored origin domain matching the reveal. Other origin protocols
are rejected.

## General calldata lookup

This route is disabled by default while the Sealevel reveal flow is redesigned; set
`CCS_CALLDATA_LOOKUP_ENABLED=true` to register it.

For `GET /callCommitments/calldata/:commitment`, sign with:

- `sender`: the service's EVM address;
- `data`: the 32-byte commitment;
- `urlTemplate`: the public base URL ending in `/callCommitments/calldata` (without the commitment).

Send credentials in headers:

```http
Authorization: Hyperlane-Signature 0x<65-byte EVM signature>
X-Hyperlane-Sender: 0x<service EVM address>
```

```typescript
const signature = await signer.signMessage(
  utils.arrayify(
    offchainLookupRequestMessageHash(
      await signer.getAddress(),
      commitment,
      `${baseUrl}/calldata`,
    ),
  ),
);
const response = await fetch(`${baseUrl}/calldata/${commitment}`, {
  headers: {
    Authorization: `Hyperlane-Signature ${signature}`,
    'X-Hyperlane-Sender': await signer.getAddress(),
  },
  redirect: 'error',
});
```

The server uses its configured URL, never the request's Host header. Missing or invalid
credentials return 401; a signer outside either applicable whitelist receives 403.
Query-string credentials are not accepted. Every 401 has the same body; the server logs
its cause at warn as `reason`: `missing_v2_fields` (for example a v1 POST body),
`malformed_credentials`, `stale_signature`, `future_dated_signature`, `invalid_signature`
or `get_sender_mismatch`. A reveal whose signed `message_id` is not the reveal's is
logged with both ids before the 403.

## Uploads, compatibility, and rollout

- `POST /callCommitments/calls`: existing EVM uploads; Aero MetaSwaps still uses this.
- `POST /callCommitments/calldata`: general EVM/SVM uploads; preferred for new integrations.
  EVM ABI payloads also populate the legacy record for existing reveal lookups.
- `GET /callCommitments/calls/:commitment`: metadata/existence only; returns no calls or salt.

These routes retain their existing behavior. Keep the EVM adapter while deployed
CommitmentReadIsm contracts and applications still use it. No database or contract
migration is required for authentication.

Deploy authenticated GET clients before enabling the CCS whitelist:

1. Update Solana relayers. Set `chains.<solana-chain>.ccsSigner` to their existing EVM
   signer configuration (hex key, AWS KMS, or GCP KMS). This is separate from their Solana
   transaction signer. Our infrastructure reuses each context's existing EVM AWS KMS
   identity; no new key is created. A missing or unavailable CCS signer disables automated
   reveals with a warning; ordinary Solana delivery stays available. CCS URLs are validated
   at startup and must use HTTPS without credentials, a query, or a fragment.
2. Update any other GET readers. The universal-router-engine's optional EVM signature
   already hashes these same fields, but its query parameters must move to the headers
   above. Its upload-only usage is unaffected.
3. Before deployment, confirm partner-operated reader identities and existing per-record
   relayer lists against the intended service whitelist. Include every intended reader in
   both applicable lists. Deploy CCS with the audited whitelist. EVM POST clients must
   sign v2; relayers that sign reveal lookups with v1 get 401 until they are updated.

## Local HTTP integration tests

`tests/e2e/ccsAuthServer.mjs` runs the real CCS handlers behind local HTTPS, uploads
five EVM/SVM fixtures to PostgreSQL, and checks unsigned reads and record restrictions.
The harness constructs the service from local registry addresses with the calldata lookup
enabled. It also serves local JSON-RPC endpoints for two origin chains, one of which lists
only a V3 ICA router (`evmV3Only`), and a destination chain: each EVM fixture gets an
origin transaction whose registry mailbox dispatches the commitment and then its reveal,
and the destination router derives the stored ICA. Origin chains answer only receipt
requests. `fixtures.json` records each EVM fixture's `originTxHash` and each fixture's
reveal `messageId`. Before printing `READY`, the harness checks a v2 reveal lookup with
them, that a v1 reveal lookup gets 401, and that a v2 lookup signed for another message
id gets 403.
It accepts only a localhost database named `ccs_e2e`. Prepare that disposable database
with the normal Prisma migrations. Set `CCS_E2E_DIR` to a temporary directory containing
`ca.pem`, `tls-cert.pem`, and `tls-key.pem`; the server certificate must cover
`127.0.0.1` and have `serverAuth` extended key usage. Ports 55440 and 55441 must be free.

From the repository root, with the SDK built:

```sh
export CCS_E2E_DIR=/path/to/local/test-fixtures
export DATABASE_URL=postgresql://ccs_test@127.0.0.1:55439/ccs_e2e
pnpm -C typescript/ccip-server exec prisma migrate deploy --config prisma/config.ts
pnpm -C typescript/ccip-server exec node --import tsx tests/e2e/ccsAuthServer.mjs
```

Once the server prints `READY`, run in another terminal (with the same fixture directory):

```sh
CCS_E2E_FIXTURES="$CCS_E2E_DIR/fixtures.json" cargo test \
  --manifest-path rust/main/Cargo.toml \
  -p relayer -p hyperlane-sealevel --lib ccs_e2e -- --ignored
```

The POST test uses a real local EVM signer and signs v2 with each fixture's `messageId`.
It sends each EVM fixture's `origin_tx_hash` and expects the bound calls, and without the
hash expects HTTP 401 for every signer. The SVM test exercises the production GET
client with valid pre-signed EVM fixtures and asserts its exact signing hash. Both check
global and per-record authorization. These tests do not access production KMS or execute
on-chain swaps. Stop the fixture server and disposable database afterward.
