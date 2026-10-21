# CCS read authentication

Both CCS read APIs accept only EVM signatures from `CCS_AUTHORIZED_SIGNERS` (a nonempty
JSON array of Ethereum addresses). The same whitelist protects the EVM adapter and the
general EVM/SVM calldata API. Mainnet and testnet deployment values each include their
primary, RC, and fastpath relayer identities from `typescript/infra/config/relayer.json`.
A commitment's nonempty `relayers` list restricts access further; an empty list permits
any globally authorized signer.

Both APIs reuse the existing SDK `offchainLookupRequestMessageHash(sender, data, urlTemplate)`:

```
hash = keccak256(solidityPacked(
  [string, address, bytes, string],
  ["HYPERLANE_OFFCHAINLOOKUP", sender, data, urlTemplate]
))
signature = EIP-191-sign(hash bytes)
```

There are no timestamps, nonces, sessions, or Solana signatures. A signature can be reused
for the same signed payload and URL until the signer is removed from the whitelist. Use
HTTPS and avoid logging signatures. Protected responses use `Cache-Control: no-store`.

## Existing EVM lookup

`POST /callCommitments/getCallsFromRevealMessage` keeps its existing JSON body:

```json
{
  "sender": "0x<ISM contract address>",
  "data": "0x<ABI lookup calldata>",
  "signature": "0x<65-byte EVM signature>"
}
```

The signed URL is the configured public endpoint URL, including
`/callCommitments/getCallsFromRevealMessage`. Existing Rust and TypeScript EVM clients
continue working unchanged if their signer is whitelisted.

## General calldata lookup

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
Query-string credentials are not accepted.

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
   identity; no new key is created. A signing mailbox with UR reveals enabled fails
   startup if its CCS signer is missing.
2. Update any other GET readers. The universal-router-engine's optional EVM signature
   already hashes these same fields, but its query parameters must move to the headers
   above. Its upload-only usage is unaffected.
3. Deploy CCS with the whitelist. Existing EVM POST clients need no protocol changes.

## Local HTTP integration tests

`tests/e2e/ccsAuthServer.mjs` runs the real CCS handlers behind local HTTPS, uploads
four EVM/SVM fixtures to PostgreSQL, and checks unsigned reads and record restrictions.
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

The POST test uses a real local EVM signer. The SVM test exercises the production GET
client with valid pre-signed EVM fixtures and asserts its exact signing hash. Both check
global and per-record authorization. These tests do not access production KMS or execute
on-chain swaps. Stop the fixture server and disposable database afterward.
