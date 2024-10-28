use core::integer::{u256_wide_mul, u512_safe_div_rem_by_u256};
use core::option::OptionTrait;
use core::traits::TryInto;
/// Multiplies two `u256` values and then divides by a third `u256` value.
///
/// # Parameters
///
/// - `a`: The first multiplicand, a `u256` value.
/// - `b`: The second multiplicand, a `u256` value.
/// - `c`: The divisor, a `u256` value. Must not be zero.
///
/// # Returns
///
/// - The result of the operation `(a * b) / c`, as a `u256` value.
///
/// # Panics
///
/// - Panics if `c` is zero, as division by zero is undefined.
pub fn mul_div(a: u256, b: u256, c: u256) -> u256 {
    if c == 0 {
        panic!("mul_div division by zero");
    }
    let (q, _) = u512_safe_div_rem_by_u256(u256_wide_mul(a, b), c.try_into().unwrap());
    q.try_into().expect('mul_div result gt u256')
}
