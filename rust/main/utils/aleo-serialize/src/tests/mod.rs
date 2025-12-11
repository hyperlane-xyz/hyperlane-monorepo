use super::*;
use snarkvm::prelude::TestnetV0;

#[test]
fn test_u32_roundtrip() {
    let pt = <u32 as AleoSerialize<TestnetV0>>::to_plaintext(&42).unwrap();
    let parsed = <u32 as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, 42);
    let pt2 = <u32 as AleoSerialize<TestnetV0>>::to_plaintext(&parsed).unwrap();
    assert_eq!(pt, pt2);
}

#[test]
fn test_boolean_roundtrip() {
    for b in [true, false] {
        let pt = <bool as AleoSerialize<TestnetV0>>::to_plaintext(&b).unwrap();
        let parsed = <bool as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
        assert_eq!(parsed, b);
        assert_eq!(
            pt,
            <bool as AleoSerialize<TestnetV0>>::to_plaintext(&parsed).unwrap()
        );
    }
}

#[test]
fn test_u8_array_roundtrip() {
    let arr: [u8; 3] = [1, 2, 3];
    let pt = <[u8; 3] as AleoSerialize<TestnetV0>>::to_plaintext(&arr).unwrap();
    let parsed = <[u8; 3] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, arr);
    assert_eq!(
        pt,
        <[u8; 3] as AleoSerialize<TestnetV0>>::to_plaintext(&parsed).unwrap()
    );
}

#[test]
fn test_array_length_mismatch() {
    let pt = <[u8; 3] as AleoSerialize<TestnetV0>>::to_plaintext(&[9u8, 8, 7]).unwrap();
    let err = <[u8; 2] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap_err();
    assert!(format!("{err}").contains("Expected array length 2"));
}

#[test]
fn test_array_wrong_variant() {
    let pt_bool = <bool as AleoSerialize<TestnetV0>>::to_plaintext(&true).unwrap();
    let err = <[u8; 1] as AleoSerialize<TestnetV0>>::parse_value(pt_bool).unwrap_err();
    assert!(format!("{err}").contains("Expected Array"));
}

#[test]
fn test_parse_wrong_variant() {
    let pt_bool = <bool as AleoSerialize<TestnetV0>>::to_plaintext(&true).unwrap();
    let err = <u32 as AleoSerialize<TestnetV0>>::parse_value(pt_bool).unwrap_err();
    assert!(format!("{err}").contains("Expected U32"));
}

#[test]
fn test_plaintext_passthrough() {
    let original = <u64 as AleoSerialize<TestnetV0>>::to_plaintext(&123456u64).unwrap();
    let parsed =
        <Plaintext<TestnetV0> as AleoSerialize<TestnetV0>>::parse_value(original.clone()).unwrap();
    assert_eq!(original, parsed);
    let back = <Plaintext<TestnetV0> as AleoSerialize<TestnetV0>>::to_plaintext(&parsed).unwrap();
    assert_eq!(original, back);
}

#[test]
fn test_u8_edge_values() {
    for v in [0u8, u8::MAX] {
        let pt = <u8 as AleoSerialize<TestnetV0>>::to_plaintext(&v).unwrap();
        let parsed = <u8 as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
        assert_eq!(parsed, v);
    }
}

#[test]
fn test_u64_edge_values() {
    for v in [0u64, 1u64, u64::MAX] {
        let pt = <u64 as AleoSerialize<TestnetV0>>::to_plaintext(&v).unwrap();
        let parsed = <u64 as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
        assert_eq!(parsed, v);
    }
}

#[test]
fn test_u128_edge_values() {
    for v in [0u128, 1u128, u128::MAX] {
        let pt = <u128 as AleoSerialize<TestnetV0>>::to_plaintext(&v).unwrap();
        let parsed = <u128 as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
        assert_eq!(parsed, v);
    }
}

#[test]
fn test_u32_edge_values() {
    for v in [0u32, 1u32, u32::MAX] {
        let pt = <u32 as AleoSerialize<TestnetV0>>::to_plaintext(&v).unwrap();
        let parsed = <u32 as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
        assert_eq!(parsed, v);
    }
}

#[test]
fn test_bool_array_roundtrip() {
    let arr: [bool; 4] = [true, false, true, false];
    let pt = <[bool; 4] as AleoSerialize<TestnetV0>>::to_plaintext(&arr).unwrap();
    let parsed = <[bool; 4] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, arr);
}

#[test]
fn test_u32_array_roundtrip() {
    let arr: [u32; 4] = [0, 1, 2, 3];
    let pt = <[u32; 4] as AleoSerialize<TestnetV0>>::to_plaintext(&arr).unwrap();
    let parsed = <[u32; 4] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, arr);
}

#[test]
fn test_u64_array_roundtrip() {
    let arr: [u64; 3] = [0, 1, 2_000_000_000];
    let pt = <[u64; 3] as AleoSerialize<TestnetV0>>::to_plaintext(&arr).unwrap();
    let parsed = <[u64; 3] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, arr);
}

#[test]
fn test_u128_array_roundtrip() {
    let arr: [u128; 2] = [0, 1_000_000_000_000_000_000u128];
    let pt = <[u128; 2] as AleoSerialize<TestnetV0>>::to_plaintext(&arr).unwrap();
    let parsed = <[u128; 2] as AleoSerialize<TestnetV0>>::parse_value(pt.clone()).unwrap();
    assert_eq!(parsed, arr);
}

#[test]
fn test_wrong_variant_for_each_integer() {
    let pt_bool = <bool as AleoSerialize<TestnetV0>>::to_plaintext(&true).unwrap();
    for (name, res) in [
        (
            "U8",
            <u8 as AleoSerialize<TestnetV0>>::parse_value(pt_bool.clone()).unwrap_err(),
        ),
        (
            "U32",
            <u32 as AleoSerialize<TestnetV0>>::parse_value(pt_bool.clone()).unwrap_err(),
        ),
        (
            "U64",
            <u64 as AleoSerialize<TestnetV0>>::parse_value(pt_bool.clone()).unwrap_err(),
        ),
        (
            "U128",
            <u128 as AleoSerialize<TestnetV0>>::parse_value(pt_bool.clone()).unwrap_err(),
        ),
    ] {
        let err = res;
        assert!(
            format!("{err}").contains(&format!("Expected {name}")),
            "missing expected text for {name}"
        );
    }
}

#[test]
fn test_array_type_mismatch_u128() {
    let pt = <[u128; 2] as AleoSerialize<TestnetV0>>::to_plaintext(&[1u128, 2]).unwrap();
    let err = <[u128; 3] as AleoSerialize<TestnetV0>>::parse_value(pt).unwrap_err();
    assert!(format!("{err}").contains("Expected array length 3"));
}
