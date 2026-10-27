//! Language-neutral golden vectors for the Hyperlane Sealevel program interfaces.
//!
//! Case definitions live in `../cases/*.rs`. They are `include!`d twice:
//! once against the on-chain program crates (`tests/programs.rs`, the oracle that
//! writes `../testdata/golden/*.json`), and once against
//! `hyperlane-sealevel-interface` (its `tests/golden.rs`). Both must produce
//! byte-identical JSON.
//!
//! Every case is built with [`rec!`] / [`var!`], which construct the Rust value and its
//! JSON description from the same expression, so the `fields` JSON cannot drift from
//! the encoded bytes.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    hash::Hash,
    path::PathBuf,
};

use account_utils::{AccountData, Data, DiscriminatorData, DiscriminatorPrefixed};
use borsh::BorshSerialize;
use hyperlane_core::{H160, H256, U256};
use solana_program::{instruction::Instruction as SolanaInstruction, pubkey::Pubkey};

/// An ordered JSON value. Field order is preserved so the output mirrors borsh field order.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    /// `null`
    Null,
    /// `true` / `false`
    Bool(bool),
    /// A JSON number, pre-rendered.
    Num(String),
    /// A JSON string.
    Str(String),
    /// A JSON array.
    Arr(Vec<J>),
    /// A JSON object with ordered keys.
    Obj(Vec<(String, J)>),
}

impl J {
    /// Builds an object from `(key, value)` pairs.
    pub fn obj<K: Into<String>>(pairs: impl IntoIterator<Item = (K, J)>) -> J {
        J::Obj(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// A JSON string.
    pub fn str(s: impl Into<String>) -> J {
        J::Str(s.into())
    }

    /// A `0x`-prefixed lowercase hex string.
    pub fn hex(bytes: &[u8]) -> J {
        J::Str(format!("0x{}", hex::encode(bytes)))
    }

    fn write(&self, out: &mut String, indent: usize) {
        let pad = |out: &mut String, n: usize| out.extend(std::iter::repeat_n(' ', n));
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(n),
            J::Str(s) => write_json_string(out, s),
            J::Arr(items) if items.is_empty() => out.push_str("[]"),
            J::Arr(items) => {
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    pad(out, indent + 2);
                    item.write(out, indent + 2);
                    if i + 1 < items.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                pad(out, indent);
                out.push(']');
            }
            J::Obj(fields) if fields.is_empty() => out.push_str("{}"),
            J::Obj(fields) => {
                out.push_str("{\n");
                for (i, (k, v)) in fields.iter().enumerate() {
                    pad(out, indent + 2);
                    write_json_string(out, k);
                    out.push_str(": ");
                    v.write(out, indent + 2);
                    if i + 1 < fields.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                pad(out, indent);
                out.push('}');
            }
        }
    }

    /// Pretty-prints with two-space indentation and a trailing newline.
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out.push('\n');
        out
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A value paired with its JSON description.
pub struct Rec<T> {
    /// The Rust value.
    pub value: T,
    /// The JSON description of `value`.
    pub json: J,
    /// Set by [`var!`] to the enum variant name.
    pub variant: Option<String>,
}

impl<T> Rec<T> {
    /// Pairs a value with a hand-written JSON description. Use only for types that
    /// can't be built with a struct literal (private fields).
    pub fn raw(value: T, json: J) -> Self {
        Self {
            value,
            json,
            variant: None,
        }
    }
}

/// Converts a value (or an existing [`Rec`]) into a [`Rec`].
pub trait IntoRec {
    /// The resulting value type.
    type T;
    /// Performs the conversion.
    fn into_rec(self) -> Rec<Self::T>;
}

impl<T> IntoRec for Rec<T> {
    type T = T;
    fn into_rec(self) -> Rec<T> {
        self
    }
}

macro_rules! num_rec {
    ($($t:ty),*) => {$(
        impl IntoRec for $t {
            type T = $t;
            fn into_rec(self) -> Rec<$t> {
                Rec::raw(self, J::Num(self.to_string()))
            }
        }
    )*};
}
// Integers that fit losslessly in an IEEE-754 double are JSON numbers.
num_rec!(u8, u16, u32, i8, i16, i32);

macro_rules! str_num_rec {
    ($($t:ty),*) => {$(
        impl IntoRec for $t {
            type T = $t;
            fn into_rec(self) -> Rec<$t> {
                Rec::raw(self, J::Str(self.to_string()))
            }
        }
    )*};
}
// Wider integers are decimal strings.
str_num_rec!(u64, u128, i64, i128, usize);

impl IntoRec for bool {
    type T = bool;
    fn into_rec(self) -> Rec<bool> {
        Rec::raw(self, J::Bool(self))
    }
}

impl IntoRec for () {
    type T = ();
    fn into_rec(self) -> Rec<()> {
        Rec::raw((), J::Null)
    }
}

impl IntoRec for String {
    type T = String;
    fn into_rec(self) -> Rec<String> {
        let json = J::Str(self.clone());
        Rec::raw(self, json)
    }
}

impl IntoRec for &str {
    type T = String;
    fn into_rec(self) -> Rec<String> {
        self.to_string().into_rec()
    }
}

/// Pubkeys are base58 strings.
impl IntoRec for Pubkey {
    type T = Pubkey;
    fn into_rec(self) -> Rec<Pubkey> {
        Rec::raw(self, J::Str(self.to_string()))
    }
}

/// H256 / H160 are `0x` hex strings.
impl IntoRec for H256 {
    type T = H256;
    fn into_rec(self) -> Rec<H256> {
        Rec::raw(self, J::hex(self.as_bytes()))
    }
}

impl IntoRec for H160 {
    type T = H160;
    fn into_rec(self) -> Rec<H160> {
        Rec::raw(self, J::hex(self.as_bytes()))
    }
}

/// U256 is a decimal string.
impl IntoRec for U256 {
    type T = U256;
    fn into_rec(self) -> Rec<U256> {
        Rec::raw(self, J::Str(self.to_string()))
    }
}

impl<X: IntoRec> IntoRec for Option<X> {
    type T = Option<X::T>;
    fn into_rec(self) -> Rec<Option<X::T>> {
        match self {
            Some(x) => {
                let r = x.into_rec();
                Rec::raw(Some(r.value), r.json)
            }
            None => Rec::raw(None, J::Null),
        }
    }
}

impl<X: IntoRec> IntoRec for Vec<X> {
    type T = Vec<X::T>;
    fn into_rec(self) -> Rec<Vec<X::T>> {
        let (values, jsons): (Vec<_>, Vec<_>) = self
            .into_iter()
            .map(|x| {
                let r = x.into_rec();
                (r.value, r.json)
            })
            .unzip();
        Rec::raw(values, J::Arr(jsons))
    }
}

impl<X: IntoRec> IntoRec for Box<X> {
    type T = Box<X::T>;
    fn into_rec(self) -> Rec<Box<X::T>> {
        let r = (*self).into_rec();
        Rec::raw(Box::new(r.value), r.json)
    }
}

impl<X: IntoRec, const N: usize> IntoRec for [X; N] {
    type T = [X::T; N];
    fn into_rec(self) -> Rec<[X::T; N]> {
        let r = Vec::from(self).into_rec();
        let Ok(value) = <[X::T; N]>::try_from(r.value) else {
            unreachable!("length is N")
        };
        Rec::raw(value, r.json)
    }
}

/// Tuples are JSON arrays.
impl<A: IntoRec, B: IntoRec> IntoRec for (A, B) {
    type T = (A::T, B::T);
    fn into_rec(self) -> Rec<(A::T, B::T)> {
        let (a, b) = (self.0.into_rec(), self.1.into_rec());
        Rec::raw((a.value, b.value), J::Arr(vec![a.json, b.json]))
    }
}

/// `None` (the inner type is inferred from the field).
pub fn none<T>() -> Rec<Option<T>> {
    Rec::raw(None, J::Null)
}

/// An empty vector.
pub fn empty<T>() -> Rec<Vec<T>> {
    Rec::raw(vec![], J::Arr(vec![]))
}

/// A byte vector, described as a `0x` hex string.
pub fn bytes(b: impl Into<Vec<u8>>) -> Rec<Vec<u8>> {
    let b = b.into();
    let json = J::hex(&b);
    Rec::raw(b, json)
}

/// A fixed-size byte array, described as a `0x` hex string.
pub fn byte_array<const N: usize>(b: [u8; N]) -> Rec<[u8; N]> {
    Rec::raw(b, J::hex(&b))
}

/// A map, described as an array of `[key, value]` pairs. Borsh encodes maps sorted by
/// key; pass pairs in ascending key order so the JSON reads the same way.
pub fn map<M, K: IntoRec, V: IntoRec>(pairs: Vec<(K, V)>) -> Rec<M>
where
    M: FromIterator<(K::T, V::T)>,
{
    let r = pairs.into_rec();
    Rec::raw(r.value.into_iter().collect(), r.json)
}

/// A set, described as an array. Pass items in ascending order.
pub fn set<S, X: IntoRec>(items: Vec<X>) -> Rec<S>
where
    S: FromIterator<X::T>,
{
    let r = items.into_rec();
    Rec::raw(r.value.into_iter().collect(), r.json)
}

/// Type-check helpers so `map`/`set` callers don't need turbofish.
pub fn hash_map<K: IntoRec, V: IntoRec>(pairs: Vec<(K, V)>) -> Rec<HashMap<K::T, V::T>>
where
    K::T: Eq + Hash,
{
    map(pairs)
}

/// See [`hash_map`].
pub fn btree_map<K: IntoRec, V: IntoRec>(pairs: Vec<(K, V)>) -> Rec<BTreeMap<K::T, V::T>>
where
    K::T: Ord,
{
    map(pairs)
}

/// See [`hash_map`].
pub fn hash_set<X: IntoRec>(items: Vec<X>) -> Rec<HashSet<X::T>>
where
    X::T: Eq + Hash,
{
    set(items)
}

/// See [`hash_map`].
pub fn btree_set<X: IntoRec>(items: Vec<X>) -> Rec<BTreeSet<X::T>>
where
    X::T: Ord,
{
    set(items)
}

/// Wraps a value in `DiscriminatorPrefixed`; the JSON is the inner value's.
pub fn prefixed<X: IntoRec>(x: X) -> Rec<DiscriminatorPrefixed<X::T>>
where
    X::T: account_utils::DiscriminatorPrefixedData,
{
    let r = x.into_rec();
    Rec {
        value: DiscriminatorPrefixed::new(r.value),
        json: r.json,
        variant: r.variant,
    }
}

/// An `OptionalDiscriminatedData` trailing field; the JSON is the inner value or `null`.
pub fn opt_disc<X: IntoRec>(x: Option<X>) -> Rec<account_utils::OptionalDiscriminatedData<X::T>> {
    let r = x.into_rec();
    Rec::raw(account_utils::OptionalDiscriminatedData(r.value), r.json)
}

/// An absent `OptionalDiscriminatedData` trailing field (`null`, zero bytes).
pub fn opt_disc_none<T>() -> Rec<account_utils::OptionalDiscriminatedData<T>> {
    Rec::raw(account_utils::OptionalDiscriminatedData(None), J::Null)
}

/// A deterministic, non-trivial pubkey: bytes `n, n+1, ..., n+31` (wrapping).
pub fn pk(n: u8) -> Pubkey {
    Pubkey::new_from_array(seq::<32>(n))
}

/// A deterministic, non-trivial H256: bytes `n, n+1, ..., n+31` (wrapping).
pub fn h256(n: u8) -> H256 {
    H256(seq::<32>(n))
}

/// A deterministic, non-trivial H160: bytes `n, n+1, ..., n+19` (wrapping).
pub fn h160(n: u8) -> H160 {
    H160(seq::<20>(n))
}

/// `n, n+1, ...` (wrapping) as a byte array.
pub fn seq<const N: usize>(n: u8) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = n.wrapping_add(i as u8);
    }
    out
}

/// Last `::` segment of a stringified path.
#[doc(hidden)]
pub fn last_segment(path: &str) -> String {
    path.rsplit("::").next().unwrap_or(path).trim().to_string()
}

/// Builds a struct (or struct-like enum variant, see [`var!`]) and its JSON description.
///
/// `rec!(path::Struct { a: x, b: y })` evaluates each field through [`IntoRec`].
#[macro_export]
macro_rules! rec {
    ($($seg:ident)::+ { $($f:ident : $e:expr),* $(,)? }) => {{
        $( let $f = $crate::IntoRec::into_rec($e); )*
        let json = $crate::J::Obj(vec![$( (stringify!($f).to_string(), $f.json.clone()) ),*]);
        $crate::Rec::raw($($seg)::+ { $($f: $f.value),* }, json)
    }};
}

/// Builds an enum variant and its JSON description (serde-style external tagging):
/// unit variants are `"Name"`, newtype `{"Name": inner}`, tuple `{"Name": [..]}`,
/// struct `{"Name": {..}}`. The variant name is recorded on the [`Rec`].
#[macro_export]
macro_rules! var {
    ($($seg:ident)::+ { $($f:ident : $e:expr),* $(,)? }) => {{
        let name = $crate::last_segment(stringify!($($seg)::+));
        let inner = $crate::rec!($($seg)::+ { $($f: $e),* });
        $crate::Rec {
            value: inner.value,
            json: $crate::J::obj([(name.clone(), inner.json)]),
            variant: Some(name),
        }
    }};
    ($($seg:ident)::+ ( $e:expr )) => {{
        let name = $crate::last_segment(stringify!($($seg)::+));
        let inner = $crate::IntoRec::into_rec($e);
        $crate::Rec {
            value: $($seg)::+(inner.value),
            json: $crate::J::obj([(name.clone(), inner.json)]),
            variant: Some(name),
        }
    }};
    ($($seg:ident)::+ ( $a:expr, $b:expr )) => {{
        let name = $crate::last_segment(stringify!($($seg)::+));
        let (a, b) = ($crate::IntoRec::into_rec($a), $crate::IntoRec::into_rec($b));
        $crate::Rec {
            value: $($seg)::+(a.value, b.value),
            json: $crate::J::obj([(name.clone(), $crate::J::Arr(vec![a.json, b.json]))]),
            variant: Some(name),
        }
    }};
    ($($seg:ident)::+) => {{
        let name = $crate::last_segment(stringify!($($seg)::+));
        $crate::Rec {
            value: $($seg)::+,
            json: $crate::J::Str(name.clone()),
            variant: Some(name),
        }
    }};
}

/// Lists an enum's variant names and compiles an exhaustive `match` over them, so adding
/// a variant to the enum breaks the build until a golden case covers it.
///
/// `variants!(path::Enum => [Unit, Newtype(_), Struct { .. }])`
#[macro_export]
macro_rules! variants {
    ($($seg:ident)::+ => [$($v:ident $(( $($tp:tt)* ))? $({ $($sp:tt)* })?),* $(,)?]) => {{
        #[allow(dead_code)]
        fn exhaustive(x: &$($seg)::+) {
            type T = $($seg)::+;
            match x {
                $( T::$v $(( $($tp)* ))? $({ $($sp)* })? => {} )*
            }
        }
        [$(stringify!($v)),*]
    }};
}

/// Records every variant of a `#[repr(u32)]` error enum with its code, with an exhaustive
/// `match` so a new variant breaks the build until it's listed.
///
/// `error_codes!(g, path::Error => [A, B])`
#[macro_export]
macro_rules! error_codes {
    ($g:expr, $($seg:ident)::+ => [$($v:ident),* $(,)?]) => {{
        let _ = $crate::variants!($($seg)::+ => [$($v),*]);
        type T = $($seg)::+;
        let name = $crate::last_segment(stringify!($($seg)::+));
        $( $g.error(&format!("{}.{}", name, stringify!($v)), T::$v as u32); )*
    }};
}

/// One encoded value.
pub struct Golden {
    /// `<program>.<RustTypeName>`, e.g. `mailbox.Instruction`.
    pub type_name: String,
    /// Enum variant name, if the top-level type is an enum.
    pub variant: Option<String>,
    /// Distinguishes multiple cases of the same type/variant.
    pub name: Option<String>,
    /// How `hex` was framed; see the README.
    pub encoding: &'static str,
    /// 8-byte discriminator prefix, when the encoding has one.
    pub discriminator: Option<Vec<u8>>,
    /// JSON description of the value (the variant payload for enums).
    pub fields: J,
    /// The encoded bytes.
    pub bytes: Vec<u8>,
}

/// A PDA derivation.
pub struct Pda {
    name: String,
    program_id: Pubkey,
    seeds: Vec<Vec<u8>>,
    address: Pubkey,
    bump: u8,
}

/// A serialized instruction produced by an instruction-builder helper.
pub struct BuiltInstruction {
    name: String,
    instruction: SolanaInstruction,
}

/// All golden data for one program or library.
pub struct GoldenFile {
    program: String,
    values: Vec<Golden>,
    instructions: Vec<BuiltInstruction>,
    pdas: Vec<Pda>,
    errors: Vec<(String, u32)>,
    constants: Vec<(String, J)>,
}

impl GoldenFile {
    /// Creates an empty file for `program`.
    pub fn new(program: &str) -> Self {
        Self {
            program: program.to_string(),
            values: vec![],
            instructions: vec![],
            pdas: vec![],
            errors: vec![],
            constants: vec![],
        }
    }

    fn type_name(&self, ty: &str) -> String {
        format!("{}.{}", self.program, ty)
    }

    /// Records a value encoded by `encode`.
    pub fn record<T>(
        &mut self,
        ty: &str,
        name: Option<&str>,
        encoding: &'static str,
        discriminator: Option<&[u8]>,
        rec: Rec<T>,
        encode: impl FnOnce(T) -> Vec<u8>,
    ) {
        let (variant, fields) = split_variant(rec.variant, rec.json);
        self.values.push(Golden {
            type_name: self.type_name(ty),
            variant,
            name: name.map(str::to_string),
            encoding,
            discriminator: discriminator.map(<[u8]>::to_vec),
            fields,
            bytes: encode(rec.value),
        });
    }

    /// Interface-style instructions: a per-variant 8-byte discriminator followed by the
    /// variant payload, as produced by the type's own `encode`.
    pub fn variant_discriminated<T>(
        &mut self,
        ty: &str,
        name: Option<&str>,
        rec: Rec<T>,
        encode: impl FnOnce(&T) -> Vec<u8>,
    ) {
        let bytes = encode(&rec.value);
        let (variant, fields) = split_variant(rec.variant, rec.json);
        self.values.push(Golden {
            type_name: self.type_name(ty),
            variant,
            name: name.map(str::to_string),
            encoding: "variant_discriminator+payload",
            discriminator: Some(bytes[..8].to_vec()),
            fields,
            bytes,
        });
    }

    /// Plain borsh.
    pub fn borsh<T: BorshSerialize>(&mut self, ty: &str, rec: Rec<T>) {
        self.borsh_named(ty, None, rec)
    }

    /// Plain borsh, with a case name.
    pub fn borsh_named<T: BorshSerialize>(&mut self, ty: &str, name: Option<&str>, rec: Rec<T>) {
        self.record(ty, name, "borsh", None, rec, |v| {
            borsh::to_vec(&v).expect("borsh")
        })
    }

    /// `DISCRIMINATOR || borsh(value)` (account-utils `DiscriminatorEncode`).
    pub fn discriminated<T: account_utils::DiscriminatorEncode>(&mut self, ty: &str, rec: Rec<T>) {
        self.discriminated_named(ty, None, rec)
    }

    /// See [`Self::discriminated`].
    pub fn discriminated_named<T: account_utils::DiscriminatorEncode>(
        &mut self,
        ty: &str,
        name: Option<&str>,
        rec: Rec<T>,
    ) {
        self.record(
            ty,
            name,
            "discriminator+borsh",
            Some(T::DISCRIMINATOR_SLICE),
            rec,
            |v| v.encode().expect("encode"),
        )
    }

    /// On-chain account layout: `0x01 (initialized) || borsh(value)`, as written by
    /// account-utils `AccountData::store_in_slice` into an exactly-sized buffer.
    pub fn account<T: Data>(&mut self, ty: &str, rec: Rec<T>) {
        self.account_named(ty, None, rec)
    }

    /// See [`Self::account`].
    pub fn account_named<T: Data>(&mut self, ty: &str, name: Option<&str>, rec: Rec<T>) {
        self.record(ty, name, "account", None, rec, store_account)
    }

    /// On-chain account layout with a discriminator:
    /// `0x01 || DISCRIMINATOR || borsh(value)` (`AccountData<DiscriminatorPrefixed<T>>`).
    pub fn account_prefixed<T: Data + DiscriminatorData>(
        &mut self,
        ty: &str,
        name: Option<&str>,
        rec: Rec<DiscriminatorPrefixed<T>>,
    ) {
        self.record(
            ty,
            name,
            "account+discriminator",
            Some(T::DISCRIMINATOR_SLICE),
            rec,
            store_account,
        )
    }

    /// Records the output of an instruction-builder helper.
    pub fn instruction(&mut self, name: &str, instruction: SolanaInstruction) {
        self.instructions.push(BuiltInstruction {
            name: name.to_string(),
            instruction,
        });
    }

    /// Records a PDA derivation.
    pub fn pda(&mut self, name: &str, program_id: &Pubkey, seeds: &[&[u8]]) {
        let (address, bump) = Pubkey::find_program_address(seeds, program_id);
        self.pdas.push(Pda {
            name: name.to_string(),
            program_id: *program_id,
            seeds: seeds.iter().map(|s| s.to_vec()).collect(),
            address,
            bump,
        });
    }

    /// `(address, bump)` of the most recently recorded PDA.
    pub fn last_pda(&self) -> (Pubkey, u8) {
        let p = self.pdas.last().expect("no PDA recorded");
        (p.address, p.bump)
    }

    /// Records one error code, for enums without `FromPrimitive`.
    pub fn error(&mut self, name: &str, code: u32) {
        self.errors.push((name.to_string(), code));
    }

    /// Records a byte constant.
    pub fn constant_bytes(&mut self, name: &str, value: &[u8]) {
        self.constants.push((name.to_string(), J::hex(value)));
    }

    /// Records a numeric/string constant.
    pub fn constant<X: IntoRec>(&mut self, name: &str, value: X) {
        self.constants
            .push((name.to_string(), value.into_rec().json));
    }

    /// Variant names recorded for `ty`.
    pub fn variants_of(&self, ty: &str) -> BTreeSet<String> {
        let ty = self.type_name(ty);
        self.values
            .iter()
            .filter(|g| g.type_name == ty)
            .filter_map(|g| g.variant.clone())
            .collect()
    }

    /// Asserts the recorded variants of `ty` are exactly `expected`.
    pub fn assert_variants(&self, ty: &str, expected: &[&str]) {
        let expected: BTreeSet<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            self.variants_of(ty),
            expected,
            "{}.{ty}: golden cases don't cover exactly the enum's variants",
            self.program
        );
    }

    /// Renders the file as JSON.
    pub fn to_json(&self) -> J {
        let values = self.values.iter().map(|g| {
            let mut fields = vec![
                ("type".to_string(), J::str(&g.type_name)),
                (
                    "variant".to_string(),
                    g.variant.clone().map(J::Str).unwrap_or(J::Null),
                ),
            ];
            if let Some(name) = &g.name {
                fields.push(("name".to_string(), J::str(name)));
            }
            fields.push(("encoding".to_string(), J::str(g.encoding)));
            if let Some(d) = &g.discriminator {
                fields.push(("discriminator".to_string(), J::hex(d)));
            }
            fields.push(("fields".to_string(), g.fields.clone()));
            fields.push(("hex".to_string(), J::Str(hex::encode(&g.bytes))));
            J::Obj(fields)
        });
        let instructions = self.instructions.iter().map(|b| {
            let ix = &b.instruction;
            J::obj([
                ("name", J::str(&b.name)),
                ("program_id", J::Str(ix.program_id.to_string())),
                (
                    "accounts",
                    J::Arr(
                        ix.accounts
                            .iter()
                            .map(|a| {
                                J::obj([
                                    ("pubkey", J::Str(a.pubkey.to_string())),
                                    ("is_signer", J::Bool(a.is_signer)),
                                    ("is_writable", J::Bool(a.is_writable)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("hex", J::Str(hex::encode(&ix.data))),
            ])
        });
        let pdas = self.pdas.iter().map(|p| {
            J::obj([
                ("name", J::str(&p.name)),
                ("program_id", J::Str(p.program_id.to_string())),
                (
                    "seeds",
                    J::Arr(p.seeds.iter().map(|s| J::Str(hex::encode(s))).collect()),
                ),
                ("address", J::Str(p.address.to_string())),
                ("bump", J::Num(p.bump.to_string())),
            ])
        });
        let errors = self.errors.iter().map(|(name, code)| {
            J::obj([("name", J::str(name)), ("code", J::Num(code.to_string()))])
        });
        let constants = self
            .constants
            .iter()
            .map(|(name, value)| J::obj([("name", J::str(name)), ("value", value.clone())]));
        J::obj([
            ("program", J::str(&self.program)),
            ("values", J::Arr(values.collect())),
            ("instructions", J::Arr(instructions.collect())),
            ("pdas", J::Arr(pdas.collect())),
            ("errors", J::Arr(errors.collect())),
            ("constants", J::Arr(constants.collect())),
        ])
    }

    /// Path of this file's committed JSON.
    pub fn path(&self) -> PathBuf {
        golden_dir().join(format!("{}.json", self.program))
    }

    /// Asserts the rendered JSON equals the committed file. When `allow_update` is set
    /// and `GOLDEN_UPDATE=1`, rewrites the file instead.
    pub fn check(&self, allow_update: bool) {
        let rendered = self.to_json().to_pretty();
        let path = self.path();
        if allow_update && std::env::var("GOLDEN_UPDATE").as_deref() == Ok("1") {
            std::fs::write(&path, rendered).expect("write golden file");
            return;
        }
        let committed = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        if committed != rendered {
            let line = committed
                .lines()
                .zip(rendered.lines())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| committed.lines().count().min(rendered.lines().count()));
            panic!(
                "{} does not match (first difference at line {}):\n  committed: {:?}\n  rendered:  {:?}",
                path.display(),
                line + 1,
                committed.lines().nth(line),
                rendered.lines().nth(line),
            );
        }
    }
}

fn split_variant(variant: Option<String>, json: J) -> (Option<String>, J) {
    match (variant, json) {
        (Some(v), J::Str(_)) => (Some(v), J::Null),
        (Some(v), J::Obj(mut fields)) if fields.len() == 1 => {
            let (_, inner) = fields.remove(0);
            (Some(v), inner)
        }
        (v, json) => (v, json),
    }
}

fn store_account<T: Data>(value: T) -> Vec<u8> {
    let len = 1 + borsh::to_vec(&value).expect("borsh").len();
    let mut buf = vec![0xAAu8; len];
    AccountData::new(value)
        .store_in_slice(&mut buf)
        .expect("store_in_slice");
    buf
}

/// Directory holding the committed golden JSON files.
pub fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/golden")
}
