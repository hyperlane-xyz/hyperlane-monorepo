//! PDA verification with a stored-bump fast path.
//!
//! `find_program_address` charges one `create_program_address` (1,500 CU) for
//! every bump it tries, so it costs `1,500 * (256 - canonical_bump)` CU.
//! Accounts that store their own canonical bump can be re-derived with a
//! single `create_program_address` instead.

use solana_program::{
    account_info::AccountInfo,
    pubkey::{Pubkey, MAX_SEEDS},
};

use spl_discriminator::ArrayDiscriminator as Discriminator;

use crate::DiscriminatorData;

/// Returns the canonical bump if `key` is the canonical PDA for `seeds` under
/// `program_id`, and `None` otherwise.
///
/// If `create_program_address(seeds ++ [hint])` equals `key` the hint is
/// returned; otherwise (no hint, wrong hint, or an on-curve result) this falls
/// back to `find_program_address` + compare.
///
/// The fast path accepts any PDA bump, canonical or not, so the hint must come
/// from the data of the account at `key`, that account must be owned by
/// `program_id`, and `program_id` must only ever create accounts with canonical
/// bumps. Then the result equals the no-hint result and only the cost differs:
/// the account was created with some seeds `s'` and canonical bump `b'`, so
/// `create(seeds ++ [hint]) == key` means `seeds ++ [hint]` and `s' ++ [b']`
/// concatenate to the same bytes, i.e. `hint == b'` and `seeds` has the same
/// canonical bump as `s'`.
pub fn verify_pda_with_bump_hint(
    key: &Pubkey,
    seeds: &[&[u8]],
    bump_hint: Option<u8>,
    program_id: &Pubkey,
) -> Option<u8> {
    if let Some(bump) = bump_hint {
        if create_program_address_with_bump(seeds, bump, program_id).as_ref() == Some(key) {
            return Some(bump);
        }
    }
    let (expected_key, bump) = Pubkey::find_program_address(seeds, program_id);
    (expected_key == *key).then_some(bump)
}

/// [`verify_pda_with_bump_hint`] for an `AccountData<DiscriminatorPrefixed<T>>`
/// account whose `T` stores its PDA bump as its first field. The hint is taken
/// from `account`'s data only when `account` is owned by `program_id`,
/// initialized, and carries `T`'s discriminator.
pub fn verify_pda_with_stored_bump<T: DiscriminatorData>(
    account: &AccountInfo,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Option<u8> {
    verify_pda_with_bump_hint(
        account.key,
        seeds,
        stored_bump::<T>(account, program_id),
        program_id,
    )
}

/// Reads the first byte of `T` from an initialized, `program_id`-owned
/// `AccountData<DiscriminatorPrefixed<T>>` account.
fn stored_bump<T: DiscriminatorData>(account: &AccountInfo, program_id: &Pubkey) -> Option<u8> {
    if account.owner != program_id {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    // [initialized: bool][discriminator: [u8; 8]][bump: u8]...
    match data.get(..1 + Discriminator::LENGTH + 1)? {
        [1, rest @ ..] if rest[..Discriminator::LENGTH] == T::DISCRIMINATOR => {
            Some(rest[Discriminator::LENGTH])
        }
        _ => None,
    }
}

fn create_program_address_with_bump(
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Pubkey,
) -> Option<Pubkey> {
    if seeds.len() >= MAX_SEEDS {
        return None;
    }
    let bump = [bump];
    let mut seeds_with_bump: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    seeds_with_bump[..seeds.len()].copy_from_slice(seeds);
    seeds_with_bump[seeds.len()] = &bump;
    Pubkey::create_program_address(&seeds_with_bump[..=seeds.len()], program_id).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Foo;

    impl DiscriminatorData for Foo {
        const DISCRIMINATOR: [u8; 8] = *b"FOOFOOFO";
    }

    const SEEDS: &[&[u8]] = &[b"foo", b"-", b"bar"];

    fn account_data(bump: u8) -> Vec<u8> {
        let mut data = vec![1u8];
        data.extend_from_slice(&Foo::DISCRIMINATOR);
        data.push(bump);
        data.extend_from_slice(&[7u8; 16]);
        data
    }

    fn with_account<R>(
        key: Pubkey,
        owner: Pubkey,
        mut data: Vec<u8>,
        f: impl FnOnce(&AccountInfo) -> R,
    ) -> R {
        let mut lamports = 0;
        let account = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        f(&account)
    }

    /// A program id whose canonical bump for `SEEDS` is below 255, so that
    /// `bump + 1` is a wrong (on-curve) hint.
    fn program_with_non_max_bump() -> (Pubkey, Pubkey, u8) {
        loop {
            let program_id = Pubkey::new_unique();
            let (key, bump) = Pubkey::find_program_address(SEEDS, &program_id);
            if bump < u8::MAX {
                return (program_id, key, bump);
            }
        }
    }

    #[test]
    fn test_hint_matches_find() {
        let (program_id, key, bump) = program_with_non_max_bump();
        for hint in [None, Some(bump), Some(bump + 1), Some(0)] {
            assert_eq!(
                verify_pda_with_bump_hint(&key, SEEDS, hint, &program_id),
                Some(bump),
                "hint {hint:?}"
            );
        }
        let wrong_key = Pubkey::new_unique();
        for hint in [None, Some(bump), Some(bump + 1)] {
            assert_eq!(
                verify_pda_with_bump_hint(&wrong_key, SEEDS, hint, &program_id),
                None
            );
        }
    }

    #[test]
    fn test_non_canonical_pda_rejected_even_with_matching_hint() {
        let (program_id, _, bump) = program_with_non_max_bump();
        // Bumps above the canonical one are all on-curve; find a lower,
        // off-curve one, i.e. a real but non-canonical PDA.
        let (non_canonical_key, non_canonical_bump) = (0..bump)
            .rev()
            .find_map(|b| {
                Pubkey::create_program_address(&[SEEDS, &[&[b]]].concat(), &program_id)
                    .ok()
                    .map(|k| (k, b))
            })
            .unwrap();
        // The hint fast path accepts it (callers must only pass hints from
        // program-owned accounts, which never live at non-canonical PDAs)...
        assert_eq!(
            verify_pda_with_bump_hint(
                &non_canonical_key,
                SEEDS,
                Some(non_canonical_bump),
                &program_id
            ),
            Some(non_canonical_bump)
        );
        // ...but without a hint it is rejected, exactly like find + compare.
        assert_eq!(
            verify_pda_with_bump_hint(&non_canonical_key, SEEDS, None, &program_id),
            None
        );
    }

    #[test]
    fn test_stored_bump_requires_owner_init_and_discriminator() {
        let (program_id, key, bump) = program_with_non_max_bump();

        with_account(key, program_id, account_data(bump), |a| {
            assert_eq!(stored_bump::<Foo>(a, &program_id), Some(bump));
            assert_eq!(
                verify_pda_with_stored_bump::<Foo>(a, SEEDS, &program_id),
                Some(bump)
            );
        });
        // Wrong owner.
        with_account(key, Pubkey::new_unique(), account_data(bump), |a| {
            assert_eq!(stored_bump::<Foo>(a, &program_id), None);
        });
        // Uninitialized flag.
        let mut data = account_data(bump);
        data[0] = 0;
        with_account(key, program_id, data, |a| {
            assert_eq!(stored_bump::<Foo>(a, &program_id), None);
        });
        // Wrong discriminator.
        let mut data = account_data(bump);
        data[1] ^= 1;
        with_account(key, program_id, data, |a| {
            assert_eq!(stored_bump::<Foo>(a, &program_id), None);
        });
        // Too short.
        with_account(key, program_id, account_data(bump)[..9].to_vec(), |a| {
            assert_eq!(stored_bump::<Foo>(a, &program_id), None);
        });
        // Wrong stored bump falls back to find.
        with_account(key, program_id, account_data(bump + 1), |a| {
            assert_eq!(
                verify_pda_with_stored_bump::<Foo>(a, SEEDS, &program_id),
                Some(bump)
            );
        });
    }
}
