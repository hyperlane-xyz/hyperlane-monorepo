# Cloud checkpoint storage and KMS

Experimental, explicit-input clients. Storage/KMS constructors receive credentials.
Identity providers receive a caller-owned environment plus explicit file/process/HTTP
interfaces; configured profile discovery may read files during provider construction.
Constructors do not contact metadata services. Tests used injected public fixtures or
disposable loopback servers; no production request or signing action occurred.

`http.Transport` injects network behavior. `HttpTransport` uses std HTTP/TLS, validates
URLs/headers, forbids redirects and userinfo, requires HTTPS except an explicitly
enabled literal loopback test endpoint or narrow identity metadata policy, and caps
response bytes before JSON decoding. A separate metadata transport may enable
`allow_metadata_http`: only the implemented IMDSv2, ECS/EKS credential and GCP
metadata paths/methods on fixed metadata hosts and port80 are allowed. IMDS token
headers/TTL and GCP Metadata-Flavor are mandatory; arbitrary paths, encoded traversal,
other ports/hosts and redirects reject before I/O. Storage/KMS transports retain HTTPS.
It suppresses duplicate automatically generated Host/auth/content headers and rejects
caller transfer-encoding/content-length. Connections currently close after each
request so oversized GET cleanup cannot drain an unbounded remaining response.
**The std-only fallback still lacks DNS/connect/TLS/body wall-clock deadlines.**
Set `HttpTransport.native_curl` to an explicitly loaded shared `net/curl.zig` client
to enforce actual total/connect deadlines and atomic cancellation. Timeout values
are explicit (`timeout_ms`, `connect_timeout_ms`); choose Rust-compatible 10-second
S3 and 30-second GCS budgets in the runtime. The shared native adapter handles TLS
and bounded headers/body without redirects. Its connection-pool/performance policy
is separate remaining work; a passing deadline test is not a throughput result.

`sigv4.sign` accepts explicit credentials, UTC timestamp, region/service, raw path,
query pairs, headers and payload. It canonicalizes/escapes/sorts them, signs the
payload, includes temporary session credentials, and derives AWS4 HMAC keys with
std crypto. Secret derivation buffers are wiped on return; credentials/tokens are
caller-owned and must never be logged. No key cache or credential discovery is
hidden in signing. The AWS published S3 GET Object vector passes exactly:
[AWS SigV4 worked examples](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html).

`storage.Store` implements path-style S3 and GCS JSON media operations with the
existing Rust backend's distinct key names and formatting:

| Object                | S3                                   | GCS                           |
| --------------------- | ------------------------------------ | ----------------------------- |
| Checkpoint            | `checkpoint_N_with_id.json`, compact | same, compact                 |
| Latest index          | `checkpoint_latest_index.json`       | `gcsLatestIndexKey`           |
| Snapshot              | `merkle_snapshot.json`               | same                          |
| Metadata              | `metadata_latest.json`               | `gcsMetadataKey`              |
| Announcement          | `announcement.json`, pretty          | `gcsAnnouncementKey`, compact |
| Reorg guard           | `reorg_flag.json`, compact           | `gcsReorgFlagKey`, pretty     |
| Public reorg evidence | `reorg_rpc_responses.json`           | `gcsReorgRpcResponsesKey`     |

All objects are folder scoped. GCS trims trailing folder slashes and, when a folder
is configured, checks the legacy root `gcsReorgFlagKey` before the scoped guard.
Any existing malformed guard blocks writes. S3 reads stay anonymous even when
write credentials are supplied; only NoSuchKey 404 responses become absence.
GCS 404 becomes absence and writes require a nonempty bearer token. Object paths,
query names and values are escaped independently. Received bodies are bounded below
50 KiB, or below 8 KiB for GCS snapshots, matching Rust's exclusive bounds.

`Store.prepareRead` produces an owning native-curl GET request without I/O, using
the same URL/auth builder as synchronous reads. It preserves the exclusive byte
limits and S3/GCS 10/30-second budgets; an async engine supplies cancellation and
remaining deadlines. HTTPS is required unless literal loopback is explicitly enabled.
The trusted backend endpoint must be configured separately from announcement URLs.

Cloud publication checks configured signer, existing same-key conflicts, the target
checkpoint before latest-index advance, and snapshot authentication. It supports
Rust's latest-first publication while the runtime completes intermediate history. It
halts before guard persistence and rejects late writes; guard persistence can retry.
These methods receive already signed values: external signer reservations must be
serialized before KMS calls. There is no cross-process lease or cloud conditional
write in this client, so exactly one active writer per namespace remains mandatory.
Read-only options reject writes before sending any request. Runnable roles use these
clients through the serialized credential manager and checkpoint publisher.

`kms.awsSignDigest` calls AWS KMS Sign with MessageType DIGEST and ECDSA_SHA_256,
checks the expected response key ARN/algorithm, and validates DER against the
configured secp256k1 public key before deriving low-S/v=27/28. A request alias is
resolved once by `awsResolvePublicKey`; the owning canonical key ARN/public key
must be pinned into both Sign request identity and expected response identity.
Concrete ARN configurations require an exact match; alias resolution checks KMS
service, configured region/account and optional configured address. Alias rotation
after resolution cannot silently change the signing key. `awsGetPublicKey` retains
the explicit expected-ARN form.
[AWS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html).

`kms.gcpSignDigest` sends the raw digest and CRC32C, then requires matching key
version, HSM protection, verified request checksum and matching signature checksum.
`gcpSignDigestRetrying` matches Rust's three-total-attempt budget for integrity
failures only; key identity/protection/HTTP errors propagate immediately. Both use
std curve/scalar verification; the small DER parser handles only strict positive
ECDSA integers, with malformed length/padding/negative/scalar rejection.
[GCP asymmetricSign API](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/asymmetricSign).

KMS receives exactly the provided 32 bytes. Checkpoint EIP-191 wrapping and raw
transaction digests remain the caller's responsibility. The caller chooses key identity explicitly. `awsGetPublicKey` verifies the returned
ARN, SIGN_VERIFY usage, ECC_SECG_P256K1 key spec and ECDSA_SHA_256 support.
`gcpGetPublicKey` verifies version name, HSM protection, secp256k1 algorithm and PEM
CRC32C. Both accept only SPKI id-ecPublicKey with named secp256k1, validate the
SEC1 curve point, and optionally bind an independently configured address. They
return an owning fixed-size public key, never private material.
[AWS GetPublicKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html),
[GCP getPublicKey](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/getPublicKey).

`identity.zig` supplies explicit identity building blocks with injected transport
and caller-provided Unix time. No test reads user credential environment values/files or production metadata
endpoints; native RSA tests read only newly generated disposable fixture files:

- AWS environment credentials parse from a supplied `EnvMap`. Partial pairs fail.
  ECS/Fargate credentials and IMDSv2 token/role/credential requests cache credentials
  and refresh 300 seconds before expiry. IMDSv1 is never a fallback. Metadata HTTP
  requires explicit opt-in and a fixed link-local/metadata-host allowlist.
- AWS STS web identity receives a rotating injected token reader, explicit role
  ARN/session name, and bounded duration. It percent-encodes the form, parses the
  exact response/result/credentials XML path, and caches the temporary identity.
  Its deliberately restricted structural XML parser rejects DTD, entity, CDATA,
  comments, malformed nesting and duplicate fields; it does no external resolution.
  Supplied environment parsing returns the token file path without opening it.
- GCP metadata Workload Identity tokens require Metadata-Flavor: Google in both
  directions, support explicit downscoped scopes, and expose project/scopes reads.
  Response flavor comes from HTTP headers, never an unverified JSON field.
- Supplied authorized_user ADC JSON supports the OAuth refresh-token form and
  expiration cache. Supplied service_account ADC JSON uses an explicitly loaded
  OpenSSL 3 libcrypto dependency for RS256 JWT signing and the JWT-bearer token
  exchange/cache. No custom RSA or automatic key-file discovery was added.

`rs256.Signer` uses vetted BIO/PEM/EVP APIs, requires RSA 2048–8192 bits and
PKCS#1 v1.5 with SHA-256, rejects encrypted/ambiguous/unsupported key material
without password prompts, and bounds PEM/message sizes. JWTs pin Google token
audiences, service-account email, scope, optional kid, issued-at, and expiry no
more than one hour later. Temporary owned PEM copies and successful parsed ADC
private-key buffers are wiped before release; callers own/wipe original input
buffers. Signer jobs must finish before unloading libcrypto.
[OpenSSL EVP signing](https://docs.openssl.org/3.0/man3/EVP_DigestSignInit/),
[Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account).

Identity getters return slices borrowed until cache refresh/deinit; providers have
a single serialized owner. Snapshot/copy credentials into an owned I/O job before
refreshing or dispatching concurrent work. Store/KMS configurations borrow their
explicit credential strings; long-lived configurations must be updated safely when
identity rotates. Runtime credential leases select source-specific provider chains and injected
filesystem/token adapters; retained service callers own their cancellation and
credential refresh boundaries. Rust currently selects environment → ECS → web identity; IMDS is an
explicit additional capability, not an already existing Rust-chain behavior.

[AWS metadata credentials](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-security-credentials.html),
[AWS STS web identity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html),
[GCP workload metadata](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads),
[GCP metadata scopes](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata),
[Google OAuth refresh](https://developers.google.com/identity/protocols/oauth2/web-server).

Validation: AWS public SigV4 vector; exact object naming/body request scripts;
legacy-root guard and anonymous/authenticated boundaries; full GCS checkpoint/latest/
snapshot/announcement/evidence/guard publication sequence; AWS/GCP request shapes and
key/integrity/HSM failure cases; signature normalization and public-key binding;
three-attempt integrity retry; exact GetPublicKey metadata/SPKI/PEM cases; identity
expiration/cache/refresh/form/metadata-header cases; every truncated STS XML prefix;
real loopback HTTP byte-limit, redirect and Host tests; optional native 50 ms total
deadline against a 100 ms stalled server and immediate cancellation; optional
OpenSSL RSA signature/JWT byte equality against Node-generated and Node-verified
ephemeral RSA2048 fixtures, rejection of RSA1024/EC keys, and exact service-account
OAuth exchange plus cache behavior.

Run native adapter tests explicitly:

```sh
HYPERLANE_CLOUD_CURL_LIBRARY=/usr/lib/libcurl.4.dylib zig test zig/src/root.zig -lc --test-filter cloud
```

On Linux supply the explicit installed `libcurl.so.4` path instead. Ordinary tests
keep native cloud loading opt-in. Neither command enables production credentials.

Generate disposable native RSA fixtures outside the repository, then run both
optional backends (use explicit Linux library paths on Linux):

```sh
rs256_fixture_dir=$(mktemp -d -t ziggy-rs256)
node zig/src/cloud/testing/generate-rsa.mjs "$rs256_fixture_dir"
HYPERLANE_CLOUD_CURL_LIBRARY=/usr/lib/libcurl.4.dylib \
HYPERLANE_LIBCRYPTO_LIBRARY=/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib \
HYPERLANE_TEST_RSA_FIXTURE_DIR="$rs256_fixture_dir" \
zig test zig/src/root.zig -lc --test-filter cloud
```

Delete only that generated fixture directory after verification. Private keys/ADC
fixtures are never checked in. Native libcurl/libcrypto are declared runtime
dependencies; these backends are not a zero-dependency result.

`agents/credentials.zig` now owns serialized runtime identity leases. Construction
reads no files/network, and local-only/read-only roles do no ambient discovery.
Explicit input environment/file reader and bounded HTTP owners feed source-specific
chains: KMS custom Rusoto environment→container→web identity; S3 AWS SDK environment→
shared profiles→web identity→container→IMDSv2. KMS container failure can fall through
to web identity as in the source. Partial unused web configuration cannot shadow a
valid container identity. Storage profiles use the pinned aws-config1.1.9
resolution order: credential-file values override config, chained roles preserve
source-profile static-key preference, self references and named Environment/ECS/
IMDS sources are explicit, and cycles/depth are bounded. Profile web identity,
credential_process and legacy/session SSO are supported. Role calls use SigV4 STS
AssumeRole; SSO refresh uses its registered OIDC client and persists rotated cache
state before obtaining role credentials. Private cache writes use0600 temporary
files, file fsync, atomic rename and parent fsync. No login/browser flow is started.
Configured AWS credential commands preserve Source Unix `/bin/sh -c` semantics;
Google executable sources preserve its direct whitespace-split argv and explicit
`GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` requirement. Both run in an owned
process group with bounded stdout, cancellation and a deadline; stderr/command
content never appears in errors. An EOF before process exit cannot create an
unbounded wait. Child groups are killed and reaped on timeout or cancellation.

KMS ADC and configured GCS service-account/user/ADC identities have separate
providers/scopes and separate credential fields; AWS KMS/S3 identities are separate
as well. Lease refresh renews SigV4 UTC date and cached tokens. Borrowed leases last
until the next lease call/deinit; drain borrowers before refresh. Owned secret input,
cache and service-account buffers are wiped on release. Modern KMS ADC follows
GOOGLE_APPLICATION_CREDENTIALS→$HOME/.config/gcloud/application_default_credentials.json
→metadata and ignores CLOUDSDK_CONFIG as its pinned SDK does. It supports
service-account scoped self-signed access JWTs (sub=email, no OAuth exchange),
authorized-user refresh, external-account file/URL/executable/AWS subject tokens,
Google STS exchange and service-account impersonation/delegates. ADC billing
quota_project_id and GOOGLE_CLOUD_QUOTA_PROJECT are propagated independently of
the bearer signer identity. Existing explicit JWT lifetime remains capped at one
hour. Basic Google STS client authentication uses the pinned SDK's URL-safe
unpadded encoding. A SAML subject remains valid with embedded newlines; header
values remain constrained.

Legacy GCS ApplicationDefault preserves ya-gcp0.12/yup-oauth2 8.3.1 semantics:
GOOGLE_APPLICATION_CREDENTIALS selects a service-account key, otherwise metadata;
it does not discover modern well-known user/impersonation/WIF files. Configured
user-secret and service-account files remain separate, with Source ADC-flag and
service-account-path precedence. The configured identities can therefore differ
from KMS deliberately.

AWS federation signs an actual GetCallerIdentity envelope for Google STS without
sending that AWS request. It supports explicit environment identity/region or
metadata role/zone/credentials and configured IMDSv2 token issuance. Source IMDSv1
requires an explicit per-request ADC capability, limited to those same literal
metadata paths; default IMDS flows still require their token. Google identity and
Azure identity-token metadata paths have their mandatory request headers and no
general HTTP permission. Arbitrary HTTP endpoints remain rejected.

Cloud validation100 tests:96passed/4 shared-Curl opt-in skips, with actual native
cloud deadlines/cancel and ephemeral Node-generated/OpenSSL-verified RSA/JWTs
enabled. Manager focused13/13 includes source-specific identity selection and
quota, no local-only discovery, cached refresh, distinct identities and allocation
failures. Tests use only injected fixture files/transports or disposable local
servers and generated test keys. No production credential lookup or cloud request
was performed. Source settings and injected transport/file-reader
contexts must outlive the Manager.
