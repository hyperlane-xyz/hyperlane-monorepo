# Sealevel transaction signing with GCP Cloud KMS

Sealevel agents can use a GCP KMS Ed25519 key for their transaction fee payer,
their separate TrustedRelayer identity, or both. This works with legacy and v0
transactions, including Address Lookup Tables, in Lander and legacy delivery.
The existing `hexKey` configuration remains supported.

Use an `ASYMMETRIC_SIGN` key with algorithm `EC_SIGN_ED25519` and protection level
`SOFTWARE`. This implementation does not accept an Ethereum secp256k1 key or
claim HSM protection for Ed25519. Google documents Ed25519 as PureEdDSA: it signs
raw data rather than a digest. See [supported algorithms](https://docs.cloud.google.com/kms/docs/algorithms).

```json
{
  "chains": {
    "solanamainnet": {
      "signer": {
        "type": "gcp",
        "keyVersionName": "projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/PAYER/cryptoKeyVersions/1"
      },
      "identity": {
        "type": "gcp",
        "keyVersionName": "projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/IDENTITY/cryptoKeyVersions/1"
      }
    }
  }
}
```

`identity` is optional. Configure it only when the application requires a
separate on-chain relayer identity, and enroll the corresponding public key in
that application. The fee payer's public key still needs SOL for transaction
fees. An identity equal to the payer is deduplicated.

Credentials come from Application Default Credentials, such as the agent's GKE
Workload Identity. Grant that identity `roles/cloudkms.signerVerifier` on the
configured key, or equivalent `cloudkms.cryptoKeyVersions.viewPublicKey` and
`cloudkms.cryptoKeyVersions.useToSign` permissions. See Google's
[KMS permissions](https://docs.cloud.google.com/kms/docs/reference/permissions-and-roles).
Credentials and private key bytes do not belong in agent configuration.

Pin the concrete numeric key version. Changing the version changes the Solana
public key, so funding and application identity enrollment must be handled
before changing the configuration. A cached signer never follows the key's
primary version automatically.

Startup validates the public key's version, algorithm, protection level and PEM
checksum. Each signing request sends the exact serialized Solana message and
its CRC32C; each response must confirm the request checksum and supply a matching
signature checksum. Returned signatures are verified locally against the cached
Ed25519 public key and original message. Integrity failures get at most three
attempts; identity/algorithm/signature failures propagate immediately. A KMS
failure never falls back to a local private key.

Read-only transaction simulation remains unsigned and does not request KMS
signatures. Payer and co-signer coverage is checked before transaction signing;
signatures are assembled in the message's required static account-key order.

The separate `ccsSigner` configuration still signs EVM-style CCS requests and
therefore requires its existing secp256k1 signer. It is not the Sealevel fee
payer or TrustedRelayer identity.
