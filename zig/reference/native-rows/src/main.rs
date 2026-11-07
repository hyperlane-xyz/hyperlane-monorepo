//! Independent, stopped-fixture-only native operation evidence. Never prints
//! authorization, private payload, signed bytes, or untrusted parse error text.
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

#[cfg(test)]
use std::fs;

type Result<T> = std::result::Result<T, &'static str>;
const MAX_ROW: usize = 64 * 1024 * 1024;
const MAX_SIGNED: usize = 16 * 1024 * 1024;
const MAX_INTENT: usize = 2 * 1024 * 1024;
const MAX_TOTAL: usize = 256 * 1024 * 1024;
const PREFIX: &[u8] = b"zig_native_destination_operation_v1/";

// A first pass rejects duplicate fields recursively, including within opaque
// payloads. The second typed pass never reports serde's potentially private text.
struct NoDuplicates;
impl<'de> Deserialize<'de> for NoDuplicates {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Check;
        impl<'de> Visitor<'de> for Check {
            type Value = NoDuplicates;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON with unique keys")
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_string<E: de::Error>(self, _: String) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_none<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(NoDuplicates)
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                while seq.next_element::<NoDuplicates>()?.is_some() {}
                Ok(NoDuplicates)
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut keys = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    map.next_value::<NoDuplicates>()?;
                }
                Ok(NoDuplicates)
            }
        }
        d.deserialize_any(Check)
    }
}
fn strict<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice::<NoDuplicates>(bytes).map_err(|_| "InvalidOrDuplicateJson")?;
    serde_json::from_slice(bytes).map_err(|_| "InvalidTypedJson")
}
fn nullable<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Process,
    Announcement,
    Reveal,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Stage {
    Pending,
    Preparing,
    Ready,
    Submitting,
    Confirming,
    Delivered,
    Denied,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Protocol {
    Ethereum,
    Sealevel,
    Cosmos,
    Cosmosnative,
    Starknet,
    Aleo,
    Radix,
    Tron,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum IdentityKind {
    Hash256,
    Signature512,
}
impl IdentityKind {
    fn length(self) -> usize {
        match self {
            Self::Hash256 => 32,
            Self::Signature512 => 64,
        }
    }
    fn tag(self) -> u8 {
        match self {
            Self::Hash256 => 0,
            Self::Signature512 => 1,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    marker: String,
    db_path: String,
    origin_namespace: String,
    origin: u32,
    destination: u32,
    operations: Vec<Expected>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    id: String,
    nonce: u32,
    kind: Kind,
    #[serde(deserialize_with = "nullable")]
    target: Option<String>,
    #[serde(deserialize_with = "nullable")]
    context: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Deadline {
    unix_ms: u64,
    delay_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    context: String,
    id: String,
    nonce: u32,
    origin: u32,
    destination: u32,
    kind: Kind,
    #[serde(deserialize_with = "nullable")]
    target: Option<String>,
    stage: Stage,
    generation: u64,
    retries: u32,
    confirmation_started: bool,
    #[serde(deserialize_with = "nullable")]
    deadline: Option<Deadline>,
    #[serde(deserialize_with = "nullable")]
    intent: Option<String>,
    #[serde(deserialize_with = "nullable")]
    authorization: Option<String>,
    #[serde(deserialize_with = "nullable")]
    identity_kind: Option<IdentityKind>,
    #[serde(deserialize_with = "nullable")]
    identity_hex: Option<String>,
    #[serde(deserialize_with = "nullable")]
    signed_hex: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Authority {
    protocol: Protocol,
    origin: u32,
    destination: u32,
    mailbox: String,
    chain_id: String,
    #[serde(deserialize_with = "nullable")]
    origin_hook: Option<String>,
    operation_id: String,
    generation: u64,
    kind: Kind,
    #[serde(deserialize_with = "nullable")]
    target: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    authority: Authority,
    payload: Box<serde_json::value::RawValue>,
}
#[derive(Serialize)]
struct Bytes {
    bytes: usize,
    sha256: String,
}
fn fingerprint(bytes: &[u8]) -> Bytes {
    Bytes {
        bytes: bytes.len(),
        sha256: encode(&Sha256::digest(bytes)),
    }
}
#[derive(Serialize)]
struct Identity {
    kind: IdentityKind,
    hex: String,
}
#[derive(Serialize)]
struct Evidence {
    id: String,
    present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<Operation>,
}
#[derive(Serialize)]
struct Operation {
    version: u8,
    context: String,
    expected_context_checked: bool,
    nonce: u32,
    origin: u32,
    destination: u32,
    kind: Kind,
    target: Option<String>,
    stage: Stage,
    generation: u64,
    retries: u32,
    confirmation_started: bool,
    deadline: Option<Deadline>,
    authority: Option<Authority>,
    identity: Option<Identity>,
    row: Bytes,
    stored_canonical_intent: Option<Bytes>,
    signed: Option<Bytes>,
    expenditure: Option<Expenditure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    starknet: Option<StarknetQuote>,
}
#[derive(Serialize)]
struct StarknetQuote {
    gas_limit: u64,
    estimated_cost: String,
    batch: Option<StarknetBatch>,
}
#[derive(Serialize)]
struct StarknetBatch {
    version: u8,
    members: Vec<StarknetMember>,
}
#[derive(Serialize)]
struct StarknetMember {
    operation_id: String,
    origin: u32,
    origin_hook: Option<String>,
    generation: u64,
    source_intent_digest: String,
    gas_limit: u64,
    estimated_cost: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStarknetMember {
    operation_id: String,
    origin: u32,
    #[serde(deserialize_with = "nullable")]
    origin_hook: Option<String>,
    generation: u64,
    source_intent_digest: String,
    gas_limit: u64,
    estimated_cost: Box<serde_json::value::RawValue>,
}
struct BoundedStarknetMembers(Vec<RawStarknetMember>);
impl<'de> Deserialize<'de> for BoundedStarknetMembers {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = BoundedStarknetMembers;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("at most 256 public Starknet members")
            }
            fn visit_seq<S: SeqAccess<'de>>(
                self,
                mut sequence: S,
            ) -> std::result::Result<Self::Value, S::Error> {
                let mut members = Vec::new();
                while let Some(member) = sequence.next_element::<RawStarknetMember>()? {
                    if members.len() == 256 {
                        return Err(de::Error::custom("member bound"));
                    }
                    members.push(member);
                }
                Ok(BoundedStarknetMembers(members))
            }
        }
        decoder.deserialize_seq(Members)
    }
}
fn exact_cost(raw: &serde_json::value::RawValue) -> Result<String> {
    const MAX: &str =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    let value = raw.get();
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
        || value.len() > MAX.len()
        || (value.len() == MAX.len() && value > MAX)
    {
        return Err("InvalidStarknetExactCost");
    }
    Ok(value.to_string())
}
fn member_hash(value: &str) -> Result<String> {
    // The actual BatchMember producer emits 64 hex digits without 0x.
    if value.len() != 64 {
        return Err("InvalidStarknetMemberHash");
    }
    Ok(encode(&decode(&format!("0x{value}"), Some(32), 32)?))
}
fn starknet_quote(
    payload: &serde_json::value::RawValue,
    authority: &Authority,
) -> Result<StarknetQuote> {
    let fields: HashMap<String, Box<serde_json::value::RawValue>> =
        strict(payload.get().as_bytes())?;
    let scalar_keys = ["transaction", "public_key", "gas_limit", "estimated_cost"];
    let batch_keys = [
        "batch_version",
        "batch_members",
        "batch_gas_limit",
        "batch_estimated_cost",
    ];
    if scalar_keys.iter().any(|name| !fields.contains_key(*name))
        || fields.keys().any(|name| {
            !scalar_keys.contains(&name.as_str()) && !batch_keys.contains(&name.as_str())
        })
    {
        return Err("InvalidStarknetQuoteFields");
    }
    let gas_limit: u64 = strict(fields["gas_limit"].get().as_bytes())?;
    let estimated_cost = exact_cost(&fields["estimated_cost"])?;
    let grouped = batch_keys.iter().any(|name| fields.contains_key(*name));
    let batch = if grouped {
        if authority.kind != Kind::Process
            || batch_keys.iter().any(|name| !fields.contains_key(*name))
        {
            return Err("InvalidStarknetBatchFields");
        }
        let version: u8 = strict(fields["batch_version"].get().as_bytes())?;
        let original =
            strict::<BoundedStarknetMembers>(fields["batch_members"].get().as_bytes())?.0;
        if version != 1 || !(2..=256).contains(&original.len()) {
            return Err("InvalidStarknetBatchVersionOrCount");
        }
        let _: u64 = strict(fields["batch_gas_limit"].get().as_bytes())?;
        exact_cost(&fields["batch_estimated_cost"])?;
        let mut ids = HashSet::new();
        let mut own = 0;
        let mut members = Vec::with_capacity(original.len());
        for member in original {
            let operation_id = member_hash(&member.operation_id)?;
            if !ids.insert(operation_id.clone()) {
                return Err("DuplicateStarknetMember");
            }
            let origin_hook = member.origin_hook.as_deref().map(member_hash).transpose()?;
            let cost = exact_cost(&member.estimated_cost)?;
            if decode(&operation_id, Some(32), 32)?
                == decode(&authority.operation_id, Some(32), 32)?
            {
                own += 1;
                if member.origin != authority.origin
                    || member.generation != authority.generation
                    || !same_optional(&origin_hook, &authority.origin_hook)?
                    || member.gas_limit != gas_limit
                    || cost != estimated_cost
                {
                    return Err("StarknetOwnMemberQuoteMismatch");
                }
            }
            members.push(StarknetMember {
                operation_id,
                origin: member.origin,
                origin_hook,
                generation: member.generation,
                source_intent_digest: member_hash(&member.source_intent_digest)?,
                gas_limit: member.gas_limit,
                estimated_cost: cost,
            });
        }
        if own != 1 {
            return Err("MissingStarknetOwnMember");
        }
        if members.iter().all(|member| member.gas_limit == 0) {
            return Err("StarknetBatchZeroWeight");
        }
        Some(StarknetBatch { version, members })
    } else {
        None
    };
    Ok(StarknetQuote {
        gas_limit,
        estimated_cost,
        batch,
    })
}
#[derive(Serialize)]
struct Expenditure {
    present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    marker: Option<Bytes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gas_used_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_used_hex: Option<String>,
}
fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + 2 * bytes.len());
    out.push_str("0x");
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 15) as usize] as char);
    }
    out
}

fn decode(text: &str, exact: Option<usize>, maximum: usize) -> Result<Vec<u8>> {
    let s = text.strip_prefix("0x").ok_or("InvalidHexPrefix")?;
    if s.len() % 2 != 0 || s.len() / 2 > maximum || exact.is_some_and(|n| s.len() != 2 * n) {
        return Err("InvalidHexLength");
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in s.as_bytes().as_chunks::<2>().0 {
        let nibble = |b: u8| -> Result<u8> {
            match b {
                b'0'..=b'9' => Ok(b - b'0'),
                b'a'..=b'f' => Ok(b - b'a' + 10),
                b'A'..=b'F' => Ok(b - b'A' + 10),
                _ => Err("InvalidHexDigit"),
            }
        };
        out.push(nibble(pair[0])? * 16 + nibble(pair[1])?);
    }
    Ok(out)
}
fn same_optional(a: &Option<String>, b: &Option<String>) -> Result<bool> {
    match (a, b) {
        (None, None) => Ok(true),
        (Some(a), Some(b)) => Ok(decode(a, Some(32), 32)? == decode(b, Some(32), 32)?),
        _ => Ok(false),
    }
}
fn prepared_target_matches(authority: &Authority, record: &Record) -> Result<bool> {
    // Aleo process preparation resolves the recipient program and pins it in
    // Prepared authority. Its process Operation target intentionally stays null.
    // This is not configuration verification: the family must independently
    // bind this public program hash to recipient, signed call and native SDK.
    if authority.protocol == Protocol::Aleo
        && authority.kind == Kind::Process
        && record.kind == Kind::Process
        && record.target.is_none()
    {
        return match &authority.target {
            Some(target) => {
                decode(target, Some(32), 32)?;
                Ok(true)
            }
            None => Ok(false),
        };
    }
    same_optional(&authority.target, &record.target)
}
fn validate_request(req: &Request) -> Result<()> {
    if req.marker != "ziggy-native-rows-readonly-v1"
        || req.operations.is_empty()
        || req.operations.len() > 256
    {
        return Err("ExpectedBoundedPublicFixture");
    }
    if req.origin_namespace.is_empty()
        || req.origin_namespace.len() > 256
        || !req
            .origin_namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("InvalidNamespace");
    }
    if !Path::new(&req.db_path).is_absolute() {
        return Err("ExpectedAbsoluteFixtureDatabase");
    }
    let mut ids = HashSet::new();
    for item in &req.operations {
        if !ids.insert(decode(&item.id, Some(32), 32)?) {
            return Err("DuplicateOperationId");
        }
        if let Some(context) = &item.context {
            decode(context, Some(32), 32)?;
        }
        if let Some(target) = &item.target {
            decode(target, Some(32), 32)?;
        }
        if item.kind != Kind::Process && item.target.is_none() {
            return Err("MissingAuxiliaryTarget");
        }
    }
    Ok(())
}
type MarkerIdentity = (IdentityKind, Vec<u8>);
type ParsedRecord = (Evidence, Option<MarkerIdentity>);

fn parse_record(bytes: &[u8], req: &Request, expected: &Expected) -> Result<ParsedRecord> {
    if bytes.is_empty() || bytes.len() > MAX_ROW {
        return Err("RecordLimit");
    }
    let record: Record = strict(bytes)?;
    let id = decode(&record.id, Some(32), 32)?;
    if record.version != 1
        || id != decode(&expected.id, Some(32), 32)?
        || record.nonce != expected.nonce
        || record.origin != req.origin
        || record.destination != req.destination
        || record.kind != expected.kind
        || !same_optional(&record.target, &expected.target)?
    {
        return Err("RowAuthorityMismatch");
    }
    let context = decode(&record.context, Some(32), 32)?;
    if let Some(at) = &expected.context {
        if context != decode(at, Some(32), 32)? {
            return Err("ContextMismatch");
        }
    }
    let mut authority = None;
    let mut public_starknet = None;
    let intent_digest = if let Some(wire) = &record.intent {
        if wire.is_empty() || wire.len() > MAX_INTENT {
            return Err("IntentLimit");
        }
        let intent: Intent = strict(wire.as_bytes())?;
        let auth = intent.authority;
        if intent.version != 1
            || decode(&auth.operation_id, Some(32), 32)? != id
            || auth.origin != record.origin
            || auth.destination != record.destination
            || auth.generation != record.generation
            || auth.kind != record.kind
            || !prepared_target_matches(&auth, &record)?
        {
            return Err("PreparedAuthorityMismatch");
        }
        decode(&auth.mailbox, Some(32), 32)?;
        if let Some(hook) = &auth.origin_hook {
            decode(hook, Some(32), 32)?;
        }
        if auth.chain_id.is_empty() || auth.chain_id.len() > 128 {
            return Err("InvalidPublicChainId");
        }
        // Other protocols remain opaque. Extract only the approved public
        // Starknet quote; RawValue keeps u256 costs exact without any f64 path.
        if auth.protocol == Protocol::Starknet {
            public_starknet = Some(starknet_quote(&intent.payload, &auth)?);
        }
        drop(intent.payload);
        authority = Some(auth);
        Some(fingerprint(wire.as_bytes()))
    } else {
        None
    };
    if let Some(secret) = &record.authorization {
        if secret.is_empty() || secret.len() > MAX_SIGNED || record.intent.is_none() {
            return Err("InvalidAuthorizationShape");
        }
    }
    let paired = record.identity_kind.is_some();
    if paired != record.identity_hex.is_some() || paired != record.signed_hex.is_some() {
        return Err("IncompleteSignedTuple");
    }
    let mut marker_identity = None;
    let (identity, signed) = if let Some(kind) = record.identity_kind {
        if record.intent.is_none() {
            return Err("SignedWithoutIntent");
        }
        let full = decode(
            record
                .identity_hex
                .as_deref()
                .ok_or("IncompleteSignedTuple")?,
            Some(kind.length()),
            kind.length(),
        )?;
        let raw = decode(
            record
                .signed_hex
                .as_deref()
                .ok_or("IncompleteSignedTuple")?,
            None,
            MAX_SIGNED,
        )?;
        if raw.is_empty() {
            return Err("EmptySignedBytes");
        }
        marker_identity = Some((kind, full.clone()));
        (
            Some(Identity {
                kind,
                hex: encode(&full),
            }),
            Some(fingerprint(&raw)),
        )
    } else {
        (None, None)
    };
    if record.stage == Stage::Ready && record.intent.is_none() {
        return Err("ReadyWithoutIntent");
    }
    if matches!(
        record.stage,
        Stage::Pending | Stage::Preparing | Stage::Ready
    ) && paired
    {
        return Err("UnsignedStageHasSignedTuple");
    }
    if matches!(record.stage, Stage::Submitting | Stage::Confirming)
        && (!paired || record.intent.is_none())
    {
        return Err("SignedStageMissingTuple");
    }
    Ok((
        Evidence {
            id: encode(&id),
            present: true,
            operation: Some(Operation {
                version: record.version,
                context: encode(&context),
                expected_context_checked: expected.context.is_some(),
                nonce: record.nonce,
                origin: record.origin,
                destination: record.destination,
                kind: record.kind,
                target: record.target,
                stage: record.stage,
                generation: record.generation,
                retries: record.retries,
                confirmation_started: record.confirmation_started,
                deadline: record.deadline,
                authority,
                identity,
                row: fingerprint(bytes),
                stored_canonical_intent: intent_digest,
                signed,
                expenditure: None,
                starknet: public_starknet,
            }),
        },
        marker_identity,
    ))
}
fn expenditure(bytes: Option<&[u8]>, kind: IdentityKind, identity: &[u8]) -> Result<Expenditure> {
    let Some(bytes) = bytes else {
        return Ok(Expenditure {
            present: false,
            marker: None,
            gas_used_hex: None,
            tokens_used_hex: None,
        });
    };
    if bytes.len() != 1 + kind.length() + 64
        || bytes[0] != kind.tag()
        || &bytes[1..1 + identity.len()] != identity
    {
        return Err("ExpenditureIdentityMismatch");
    }
    let offset = 1 + identity.len();
    let tokens: Vec<_> = bytes[offset..offset + 32].iter().rev().copied().collect();
    let gas: Vec<_> = bytes[offset + 32..].iter().rev().copied().collect();
    Ok(Expenditure {
        present: true,
        marker: Some(fingerprint(bytes)),
        gas_used_hex: Some(encode(&gas)),
        tokens_used_hex: Some(encode(&tokens)),
    })
}

#[cfg(unix)]
struct StoppedLock {
    _file: File,
}
#[cfg(unix)]
impl StoppedLock {
    fn acquire(db: &Path) -> Result<Self> {
        use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
        // Existing LOCK only, O_NOFOLLOW, no write/create/truncate permission.
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(db.join("LOCK"))
            .map_err(|_| "MissingOrUnsafeDatabaseLock")?;
        if !file.metadata().map_err(|_| "LockMetadataFailed")?.is_file() {
            return Err("UnsafeDatabaseLock");
        }
        let mut lock: libc::flock = unsafe { std::mem::zeroed() };
        lock.l_type = libc::F_RDLCK as _;
        lock.l_whence = libc::SEEK_SET as _;
        lock.l_start = 0;
        lock.l_len = 0;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == -1 {
            return Err("LiveWriterOrLockUnavailable");
        }
        Ok(Self { _file: file })
    }
}
fn probe(req: &Request) -> Result<serde_json::Value> {
    validate_request(req)?;
    #[cfg(not(unix))]
    {
        let _ = req;
        return Err("PosixLockRequired");
    }
    #[cfg(unix)]
    {
        let path = Path::new(&req.db_path);
        if !path.is_dir() || !path.join("CURRENT").is_file() {
            return Err("MissingFixtureDatabase");
        }
        let _guard = StoppedLock::acquire(path)?;
        let mut options = rocksdb::Options::default();
        options.create_if_missing(false);
        let db = rocksdb::DB::open_for_read_only(&options, path, false)
            .map_err(|_| "ReadonlyDatabaseOpenFailed")?;
        let mut rows = Vec::with_capacity(req.operations.len());
        let mut total = 0usize;
        for expected in &req.operations {
            let id = decode(&expected.id, Some(32), 32)?;
            let mut key = req.origin_namespace.as_bytes().to_vec();
            key.push(b'_');
            key.extend_from_slice(PREFIX);
            key.extend_from_slice(&id);
            let Some(raw) = db.get_pinned(&key).map_err(|_| "RowReadFailed")? else {
                rows.push(Evidence {
                    id: encode(&id),
                    present: false,
                    operation: None,
                });
                continue;
            };
            total = total.checked_add(raw.len()).ok_or("TotalRecordLimit")?;
            if total > MAX_TOTAL {
                return Err("TotalRecordLimit");
            }
            let (mut row, identity) = parse_record(&raw, req, expected)?;
            if let Some((kind, identity)) = identity {
                let mut key = req.origin_namespace.as_bytes().to_vec();
                key.extend_from_slice(b"_zig_native_destination_expenditure_v1/");
                key.extend_from_slice(&id);
                key.push(kind.tag());
                key.extend_from_slice(&identity);
                let marker = db.get_pinned(&key).map_err(|_| "ExpenditureReadFailed")?;
                row.operation
                    .as_mut()
                    .ok_or("MissingParsedOperation")?
                    .expenditure = Some(expenditure(marker.as_deref(), kind, &identity)?);
            }
            rows.push(row);
        }
        Ok(
            serde_json::json!({"schema":1,"reader":"independent Rust rocksdb native-row evidence","readonly":true,"complete":rows.iter().all(|r|r.present),"expected_origin":req.origin,"expected_destination":req.destination,"origin_namespace":req.origin_namespace,"configuration_authority_verified":false,"parent_stopped_receipt_required":true,"sdk_verification_required":true,"canonical_old_oracle_required":true,"rows":rows}),
        )
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 {
        return Err("ExpectedPublicFixtureRequestFile");
    }
    let file = File::open(&args[1]).map_err(|_| "RequestOpenFailed")?;
    let mut bytes = Vec::new();
    file.take((1024 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "RequestReadFailed")?;
    if bytes.len() > 1024 * 1024 {
        return Err("RequestLimit");
    }
    let req: Request = strict(&bytes)?;
    let value = probe(&req)?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value).map_err(|_| "OutputFailed")?;
    output.write_all(b"\n").map_err(|_| "OutputFailed")?;
    Ok(())
}
fn main() {
    if let Err(code) = run() {
        eprintln!("native row probe failed: {code}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(kind: IdentityKind) -> (Request, serde_json::Value) {
        let id = encode(&[0x11; 32]);
        let context = encode(&[0x22; 32]);
        let req:Request=strict(serde_json::json!({"marker":"ziggy-native-rows-readonly-v1","db_path":"/public-fixture","origin_namespace":"test1","origin":1000,"destination":2000,"operations":[{"id":id,"nonce":7,"kind":"process","target":null,"context":context}]}).to_string().as_bytes()).expect("request");
        let intent=serde_json::json!({"version":1,"authority":{"protocol":"sealevel","origin":1000,"destination":2000,"mailbox":encode(&[0x33;32]),"chain_id":"public-fixture","origin_hook":encode(&[0x44;32]),"operation_id":id,"generation":3,"kind":"process","target":null},"payload":{"public_nonce":9}}).to_string();
        let row = serde_json::json!({"version":1,"context":context,"id":id,"nonce":7,"origin":1000,"destination":2000,"kind":"process","target":null,"stage":"confirming","generation":3,"retries":0,"confirmation_started":true,"deadline":{"unix_ms":601000,"delay_ms":600000},"intent":intent,"authorization":"public-fixture-sensitive-transition-view-key","identity_kind":kind,"identity_hex":encode(&vec![0x55;kind.length()]),"signed_hex":encode(b"public-fixture-signed-wire")});
        (req, row)
    }
    #[test]
    fn both_identity_widths_hash_exact_bytes_and_never_expose_sensitive_fields() {
        for kind in [IdentityKind::Hash256, IdentityKind::Signature512] {
            let (req, row) = fixture(kind);
            validate_request(&req).expect("valid request");
            let raw = row.to_string();
            let (value, identity) =
                parse_record(raw.as_bytes(), &req, &req.operations[0]).expect("row");
            assert_eq!(identity.expect("signed").1.len(), kind.length());
            let safe = serde_json::to_string(&value).expect("safe output");
            for forbidden in [
                "sensitive-transition",
                "public_nonce",
                "public-fixture-signed-wire",
                "authorization",
                "payload",
            ] {
                assert!(!safe.contains(forbidden));
            }
            let op = value.operation.expect("present");
            assert!(op.expected_context_checked);
            assert_eq!(op.row.sha256, encode(&Sha256::digest(raw.as_bytes())));
            assert_eq!(
                op.signed.expect("wire").sha256,
                encode(&Sha256::digest(b"public-fixture-signed-wire"))
            );
            assert_eq!(
                op.identity.expect("identity").hex.len(),
                2 + 2 * kind.length()
            );
        }
    }
    #[test]
    fn observed_context_is_explicit_and_wrong_expected_context_fails() {
        let (mut req, row) = fixture(IdentityKind::Hash256);
        req.operations[0].context = None;
        let (value, _) =
            parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).expect("observed");
        assert!(!value.operation.expect("present").expected_context_checked);
        req.operations[0].context = Some(encode(&[9; 32]));
        assert!(parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err());
    }
    #[test]
    fn row_and_prepared_cross_binding_mutations_fail_closed() {
        let (req, original) = fixture(IdentityKind::Signature512);
        for (field, value) in [
            ("id", serde_json::json!(encode(&[0x99; 32]))),
            ("nonce", serde_json::json!(8)),
            ("origin", serde_json::json!(1001)),
            ("destination", serde_json::json!(2001)),
            ("generation", serde_json::json!(4)),
            ("kind", serde_json::json!("reveal")),
            ("target", serde_json::json!(encode(&[0x99; 32]))),
            ("identity_hex", serde_json::json!(encode(&[0x55; 32]))),
            ("stage", serde_json::json!("ready")),
            ("version", serde_json::json!(2)),
        ] {
            let mut row = original.clone();
            row[field] = value;
            assert!(
                parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err(),
                "{field}"
            );
        }
        for field in [
            "operation_id",
            "origin",
            "destination",
            "generation",
            "kind",
            "target",
            "mailbox",
            "origin_hook",
            "protocol",
        ] {
            let mut row = original.clone();
            let mut intent: serde_json::Value =
                serde_json::from_str(row["intent"].as_str().expect("intent"))
                    .expect("public intent");
            intent["authority"][field] = match field {
                "origin" | "destination" | "generation" => serde_json::json!(999),
                "kind" => serde_json::json!("announcement"),
                "protocol" => serde_json::json!("not-a-protocol"),
                "mailbox" | "origin_hook" => serde_json::json!("0x00"),
                _ => serde_json::json!(encode(&[0x99; 32])),
            };
            row["intent"] = serde_json::json!(intent.to_string());
            assert!(
                parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn duplicates_unknown_missing_nullable_and_incomplete_signed_tuples_fail() {
        let (req, row) = fixture(IdentityKind::Hash256);
        let raw = row.to_string();
        let duplicate = raw.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
        assert!(parse_record(duplicate.as_bytes(), &req, &req.operations[0]).is_err());
        let mut nested = row.clone();
        let intent = nested["intent"].as_str().expect("intent").replace(
            "\"public_nonce\":9",
            "\"public_nonce\":9,\"public_nonce\":9",
        );
        nested["intent"] = serde_json::json!(intent);
        assert!(parse_record(nested.to_string().as_bytes(), &req, &req.operations[0]).is_err());
        for field in [
            "target",
            "deadline",
            "intent",
            "authorization",
            "identity_kind",
            "identity_hex",
            "signed_hex",
        ] {
            let mut missing = row.clone();
            missing.as_object_mut().expect("row").remove(field);
            assert!(
                parse_record(missing.to_string().as_bytes(), &req, &req.operations[0]).is_err(),
                "missing {field}"
            );
        }
        for field in ["identity_kind", "identity_hex", "signed_hex"] {
            let mut missing = row.clone();
            missing[field] = serde_json::Value::Null;
            assert!(
                parse_record(missing.to_string().as_bytes(), &req, &req.operations[0]).is_err()
            );
        }
        let mut extra = row;
        extra["unexpected"] = serde_json::json!(1);
        assert!(parse_record(extra.to_string().as_bytes(), &req, &req.operations[0]).is_err());
        let missing_context = b"{\"id\":\"0x00\",\"nonce\":0,\"kind\":\"process\",\"target\":null}";
        assert!(strict::<Expected>(missing_context).is_err());
    }
    #[test]
    fn count_hex_and_empty_signed_bounds_are_explicit() {
        let (mut req, mut row) = fixture(IdentityKind::Hash256);
        req.operations.clear();
        assert!(validate_request(&req).is_err());
        assert!(decode("0x0000", None, 1).is_err());
        assert!(decode("0xgg", None, 1).is_err());
        assert!(decode("00", None, 1).is_err());
        let (req, _) = fixture(IdentityKind::Hash256);
        row["signed_hex"] = serde_json::json!("0x");
        assert!(parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err());
        assert_eq!(MAX_ROW, 64 * 1024 * 1024);
        assert_eq!(MAX_SIGNED, 16 * 1024 * 1024);
        assert_eq!(MAX_INTENT, 2 * 1024 * 1024);
    }
    #[test]
    fn expenditure_marker_preserves_zero_presence_and_native_identity() {
        for kind in [IdentityKind::Hash256, IdentityKind::Signature512] {
            let id = vec![0x77; kind.length()];
            let mut marker = vec![kind.tag()];
            marker.extend_from_slice(&id);
            marker.extend_from_slice(&[0; 64]);
            let absent = expenditure(None, kind, &id).expect("absent");
            assert!(!absent.present);
            assert!(absent.gas_used_hex.is_none());
            let zero = expenditure(Some(&marker), kind, &id).expect("present zero");
            assert!(zero.present);
            assert_eq!(zero.tokens_used_hex, Some(encode(&[0; 32])));
            let offset = 1 + kind.length();
            marker[offset] = 3;
            marker[offset + 32] = 5;
            let spent = expenditure(Some(&marker), kind, &id).expect("spent");
            assert_eq!(spent.gas_used_hex.expect("gas").chars().last(), Some('5'));
            marker[1] ^= 1;
            assert!(expenditure(Some(&marker), kind, &id).is_err());
            assert!(expenditure(Some(&marker[..marker.len() - 1]), kind, &id).is_err());
        }
    }
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let p = std::env::temp_dir().join(format!(
                "ziggy-native-rows-unit-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir(&p).expect("new own temp");
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn files(path: &Path) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for item in fs::read_dir(path).expect("list") {
            let item = item.expect("entry");
            if item.file_type().expect("type").is_file() {
                out.push((
                    item.file_name().to_string_lossy().into_owned(),
                    fingerprint(&fs::read(item.path()).expect("read")).sha256,
                ));
            }
        }
        out.sort();
        out
    }
    #[test]
    fn actual_readonly_rocks_probe_keeps_all_database_files_and_absence_unknown() {
        let temp = Temp::new();
        let path = temp.0.join("db");
        let (mut req, row) = fixture(IdentityKind::Hash256);
        req.db_path = path.to_string_lossy().into_owned();
        let mut key = b"test1_".to_vec();
        key.extend_from_slice(PREFIX);
        key.extend_from_slice(&[0x11; 32]);
        {
            let db = rocksdb::DB::open_default(&path).expect("writer");
            db.put(&key, row.to_string()).expect("fixture row");
            db.flush().expect("flush");
        }
        let before = files(&path);
        let evidence = probe(&req).expect("stopped read");
        assert!(evidence["complete"].as_bool().expect("complete"));
        assert!(!evidence["rows"][0]["operation"]["expenditure"]["present"]
            .as_bool()
            .expect("unknown fee"));
        assert_eq!(files(&path), before);
        req.origin_namespace = "foreign".into();
        let absent = probe(&req).expect("absent");
        assert_eq!(absent["complete"], false);
        assert_eq!(absent["rows"][0]["present"], false);
        assert_eq!(files(&path), before);
    }
    #[test]
    fn live_writer_child() {
        let Ok(path) = std::env::var("ZIGGY_NATIVE_ROWS_TEST_CHILD") else {
            return;
        };
        let db = rocksdb::DB::open_default(&path).expect("actual child writer");
        let path = Path::new(&path);
        fs::write(
            path.parent().expect("parent").join("ready"),
            b"writer locked",
        )
        .expect("ready");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !path.parent().expect("parent").join("stop").exists()
            && std::time::Instant::now() < until
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        drop(db);
    }
    #[test]
    fn actual_live_rocks_writer_lock_is_refused_and_child_is_reaped() {
        let temp = Temp::new();
        let path = temp.0.join("db");
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                if self.0.try_wait().ok().flatten().is_none() {
                    let _ = self.0.kill();
                }
                let _ = self.0.wait();
            }
        }
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().expect("test executable"))
                .args(["--exact", "tests::live_writer_child", "--nocapture"])
                .env("ZIGGY_NATIVE_ROWS_TEST_CHILD", &path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("child"),
        );
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !temp.0.join("ready").exists() {
            assert!(std::time::Instant::now() < until, "writer startup");
            assert!(child.0.try_wait().expect("poll").is_none(), "child failed");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(matches!(
            StoppedLock::acquire(&path),
            Err("LiveWriterOrLockUnavailable")
        ));
        fs::write(temp.0.join("stop"), b"stop").expect("stop");
        assert!(child.0.wait().expect("joined").success());
        assert!(StoppedLock::acquire(&path).is_ok());
    }
    fn with_starknet_payload(row: &serde_json::Value, payload: &str) -> serde_json::Value {
        let mut result = row.clone();
        let mut intent: serde_json::Value =
            serde_json::from_str(result["intent"].as_str().expect("intent")).expect("intent JSON");
        intent["authority"]["protocol"] = serde_json::json!("starknet");
        intent["payload"] = serde_json::from_str(payload).expect("test payload JSON");
        result["intent"] = serde_json::json!(intent.to_string());
        result
    }
    fn scalar_quote_body(cost: &str) -> String {
        format!(
            r#"{{"transaction":{{"sensitive-private-body":"never-output"}},"public_key":"0x7","gas_limit":1,"estimated_cost":{cost}}}"#
        )
    }
    const LARGE_COST: &str =
        "1766847064778384329583297500742918515827483896875618958121606201292619793";
    #[test]
    fn starknet_scalar_quote_keeps_exact_u256_decimal_and_never_outputs_opaque_payload() {
        let (req, base) = fixture(IdentityKind::Hash256);
        for cost in [
            "0",
            "18446744073709551617",
            LARGE_COST,
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ] {
            let row = with_starknet_payload(&base, &scalar_quote_body(cost));
            let (output, _) = parse_record(row.to_string().as_bytes(), &req, &req.operations[0])
                .expect("valid public scalar quote");
            let wire = serde_json::to_value(output).expect("safe quote");
            assert_eq!(wire["operation"]["starknet"]["gas_limit"], 1);
            assert_eq!(wire["operation"]["starknet"]["estimated_cost"], cost);
            assert!(wire["operation"]["starknet"]["batch"].is_null());
            let safe = wire.to_string();
            for secret in [
                "sensitive-private-body",
                "never-output",
                "public-fixture-signed-wire",
                "sensitive-transition",
            ] {
                assert!(!safe.contains(secret));
            }
        }
        for bad in [
            "-1",
            "1.0",
            "1e3",
            "true",
            "null",
            "\"17\"",
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
        ] {
            let row = with_starknet_payload(&base, &scalar_quote_body(bad));
            assert!(parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err());
        }
        // Lexical validation is exact even before a JSON decoder would reject
        // noncanonical leading zeros; no f64 or formatted float is involved.
        assert!(strict::<Box<serde_json::value::RawValue>>(b"01").is_err());
    }
    fn batch_quote_body(req: &Request) -> serde_json::Value {
        let cost: serde_json::Value = serde_json::from_str(LARGE_COST).expect("exact large number");
        let member = serde_json::json!({"operation_id":req.operations[0].id.strip_prefix("0x").expect("prefix"),"origin":req.origin,"origin_hook":"44".repeat(32),"generation":3,"source_intent_digest":"77".repeat(32),"gas_limit":1,"estimated_cost":cost});
        let mut sibling = member.clone();
        sibling["operation_id"] = serde_json::json!("aa".repeat(32));
        sibling["source_intent_digest"] = serde_json::json!("88".repeat(32));
        sibling["gas_limit"] = serde_json::json!(3);
        serde_json::json!({"transaction":{"nonce":"0x9","private":"never-output"},"public_key":"0x7","gas_limit":1,"estimated_cost":cost,"batch_version":1,"batch_members":[member,sibling],"batch_gas_limit":4,"batch_estimated_cost":cost})
    }
    #[test]
    fn starknet_ordered_batch_manifest_normalizes_full_hashes_and_binds_own_original_quote() {
        let (req, base) = fixture(IdentityKind::Hash256);
        let row = with_starknet_payload(&base, &batch_quote_body(&req).to_string());
        let (output, _) = parse_record(row.to_string().as_bytes(), &req, &req.operations[0])
            .expect("public batch quote");
        let value = serde_json::to_value(output).expect("safe");
        let quote = &value["operation"]["starknet"];
        assert_eq!(quote["estimated_cost"], LARGE_COST);
        assert_eq!(quote["batch"]["version"], 1);
        assert_eq!(
            quote["batch"]["members"][0]["operation_id"],
            req.operations[0].id
        );
        assert_eq!(
            quote["batch"]["members"][0]["origin_hook"],
            encode(&[0x44; 32])
        );
        assert_eq!(
            quote["batch"]["members"][0]["source_intent_digest"],
            encode(&[0x77; 32])
        );
        assert_eq!(
            quote["batch"]["members"][1]["operation_id"],
            encode(&[0xaa; 32])
        );
        assert_eq!(quote["batch"]["members"][1]["gas_limit"], 3);
        assert_eq!(quote["batch"]["members"][1]["estimated_cost"], LARGE_COST);
        assert!(!value.to_string().contains("never-output"));
    }
    #[test]
    fn starknet_quote_schema_member_authority_count_bounds_and_crossbindings_fail_closed() {
        let (req, base) = fixture(IdentityKind::Hash256);
        let valid = batch_quote_body(&req);
        let mut bads = Vec::new();
        for (key, value) in [
            ("origin", serde_json::json!(1001)),
            ("generation", serde_json::json!(4)),
            ("origin_hook", serde_json::json!("99".repeat(32))),
            ("gas_limit", serde_json::json!(2)),
            ("estimated_cost", serde_json::json!(17)),
            ("source_intent_digest", serde_json::json!("ab")),
            ("operation_id", serde_json::json!("cc".repeat(32))),
        ] {
            let mut body = valid.clone();
            body["batch_members"][0][key] = value;
            bads.push(body);
        }
        for (key, value) in [
            ("batch_version", serde_json::json!(2)),
            ("batch_version", serde_json::Value::Null),
            ("batch_members", serde_json::Value::Null),
            ("batch_gas_limit", serde_json::json!(-1)),
            ("batch_estimated_cost", serde_json::json!("17")),
            ("gas_limit", serde_json::json!(1.5)),
        ] {
            let mut body = valid.clone();
            body[key] = value;
            bads.push(body);
        }
        let mut duplicate = valid.clone();
        duplicate["batch_members"][0]["operation_id"] = serde_json::json!("aa".repeat(32));
        duplicate["batch_members"][1]["operation_id"] = serde_json::json!("AA".repeat(32));
        bads.push(duplicate);
        let mut one = valid.clone();
        one["batch_members"].as_array_mut().expect("members").pop();
        bads.push(one);
        let mut many = valid.clone();
        many["batch_members"] = serde_json::json!(vec![valid["batch_members"][0].clone(); 257]);
        bads.push(many);
        for key in [
            "gas_limit",
            "estimated_cost",
            "batch_members",
            "batch_version",
            "batch_gas_limit",
            "batch_estimated_cost",
        ] {
            let mut body = valid.clone();
            body.as_object_mut().expect("body").remove(key);
            bads.push(body);
        }
        let mut unknown = valid;
        unknown["batch_members"][0]["authorization"] = serde_json::json!("never-output");
        bads.push(unknown);
        for body in bads {
            let row = with_starknet_payload(&base, &body.to_string());
            assert!(parse_record(row.to_string().as_bytes(), &req, &req.operations[0]).is_err());
        }
    }
    #[test]
    fn aleo_process_requires_resolved_prepared_target_without_relaxing_other_protocols_or_auxiliary_kinds(
    ) {
        let (req, base) = fixture(IdentityKind::Hash256);
        let mut row = base.clone();
        let mut intent: Intent =
            strict(row["intent"].as_str().expect("intent").as_bytes()).expect("typed intent");
        let record: Record = strict(row.to_string().as_bytes()).expect("typed row");
        intent.authority.protocol = Protocol::Aleo;
        assert!(!prepared_target_matches(&intent.authority, &record).expect("no target"));
        intent.authority.target = Some(encode(&[0x77; 32]));
        assert!(prepared_target_matches(&intent.authority, &record).expect("resolved target"));
        let mut wire: serde_json::Value =
            serde_json::from_str(row["intent"].as_str().expect("intent")).expect("wire");
        wire["authority"]["protocol"] = serde_json::json!("aleo");
        wire["authority"]["target"] = serde_json::json!(encode(&[0x77; 32]));
        row["intent"] = serde_json::json!(wire.to_string());
        let (output, _) = parse_record(row.to_string().as_bytes(), &req, &req.operations[0])
            .expect("actual Aleo target shape");
        let operation = output.operation.expect("present");
        assert!(operation.target.is_none());
        assert_eq!(
            operation.authority.expect("authority").target,
            Some(encode(&[0x77; 32]))
        );
        for protocol in [
            Protocol::Ethereum,
            Protocol::Sealevel,
            Protocol::Cosmos,
            Protocol::Cosmosnative,
            Protocol::Starknet,
            Protocol::Radix,
            Protocol::Tron,
        ] {
            intent.authority.protocol = protocol;
            assert!(!prepared_target_matches(&intent.authority, &record)
                .expect("other protocol exact target"));
        }
        intent.authority.protocol = Protocol::Aleo;
        for kind in [Kind::Announcement, Kind::Reveal] {
            intent.authority.kind = kind;
            assert!(!prepared_target_matches(&intent.authority, &record).expect("aux target exact"));
        }
        intent.authority.kind = Kind::Process;
        intent.authority.target = Some("0x77".to_string());
        assert!(prepared_target_matches(&intent.authority, &record).is_err());
    }
}
