//! Allocation-free log lines for SBF programs.
//!
//! `msg!` with format arguments goes through `core::fmt` and a heap-allocated
//! `String`, which costs thousands of compute units per call on SBF. `LogLine`
//! appends pieces to a fixed stack buffer and emits them with one `sol_log`
//! syscall. Number and hash renderings match `format!` byte for byte (see tests),
//! so a `msg!` can be ported without changing the logged text.

#![deny(missing_docs)]
#![deny(unsafe_code)]

use core::fmt::{self, Write};

use solana_program::{log::sol_log, pubkey::Pubkey};

/// Chunk size for `U256` decimal rendering: 10^9 < 2^32, so a remainder
/// shifted left by 32 bits still fits in a u64.
const TEN_POW_9: u64 = 1_000_000_000;

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Capacity of a [`LogLine`] in bytes.
pub const LOG_LINE_CAPACITY: usize = 256;

/// A log line of at most [`LOG_LINE_CAPACITY`] bytes, built on the stack.
///
/// Each append is all-or-nothing: a piece that does not fit in the remaining
/// capacity is dropped, so the buffer always holds whole pieces and stays valid
/// UTF-8 (the `sol_log_` syscall rejects invalid UTF-8). Lines are short enough
/// that this never happens in practice.
pub struct LogLine {
    buf: [u8; LOG_LINE_CAPACITY],
    len: usize,
}

impl Default for LogLine {
    fn default() -> Self {
        Self::new()
    }
}

impl LogLine {
    /// An empty line.
    pub fn new() -> Self {
        Self {
            buf: [0; LOG_LINE_CAPACITY],
            len: 0,
        }
    }

    /// Appends ASCII or UTF-8 `bytes` taken from a whole `&str` or from ASCII
    /// digit rendering, or nothing if they don't fit.
    #[inline(never)]
    fn push(&mut self, bytes: &[u8]) -> &mut Self {
        if let Some(end) = self
            .len
            .checked_add(bytes.len())
            .filter(|end| *end <= LOG_LINE_CAPACITY)
        {
            self.buf[self.len..end].copy_from_slice(bytes);
            self.len = end;
        }
        self
    }

    /// Appends a string.
    #[inline(never)]
    pub fn str(&mut self, s: &str) -> &mut Self {
        self.push(s.as_bytes())
    }

    /// Appends `v` in decimal, like `{}`.
    #[inline(never)]
    pub fn u64(&mut self, v: u64) -> &mut Self {
        let mut digits = [0u8; 20];
        let start = write_decimal(v, &mut digits);
        self.push(&digits[start..])
    }

    /// Appends `v` in decimal, like `{}`.
    #[inline(never)]
    pub fn i64(&mut self, v: i64) -> &mut Self {
        if v < 0 {
            let mut digits = [0u8; 20];
            let start = write_decimal(v.unsigned_abs(), &mut digits);
            // One piece so the append stays all-or-nothing.
            let mut signed = [b'-'; 21];
            signed[start + 1..].copy_from_slice(&digits[start..]);
            return self.push(&signed[start..]);
        }
        self.u64(v as u64)
    }

    /// Appends `true` or `false`, like `{}`.
    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.str(if v { "true" } else { "false" })
    }

    /// Appends `Some(<f's output>)` or `None`, like `{:?}` on `Option`.
    pub fn option<T>(
        &mut self,
        v: Option<T>,
        f: impl FnOnce(&mut Self, T) -> &mut Self,
    ) -> &mut Self {
        match v {
            Some(inner) => {
                self.str("Some(");
                f(self, inner);
                self.str(")")
            }
            None => self.str("None"),
        }
    }

    /// Appends a little-endian 256-bit integer (`primitive_types::U256.0`) in
    /// decimal, like `{}` on `U256`.
    #[inline(never)]
    pub fn u256(&mut self, limbs: [u64; 4]) -> &mut Self {
        if limbs[1] == 0 && limbs[2] == 0 && limbs[3] == 0 {
            return self.u64(limbs[0]);
        }
        // Long division by 10^9 over 32-bit limbs keeps every step within a
        // native u64 divide (`U256`'s own `Display` divides the full 256-bit
        // value by ten per digit). 2^256 has 78 decimal digits: nine chunks.
        let mut n = [0u32; 8];
        for (i, limb) in limbs.iter().enumerate() {
            n[2 * i] = *limb as u32;
            n[2 * i + 1] = (*limb >> 32) as u32;
        }
        let mut top = n.len();
        let mut chunks = [0u32; 9];
        let mut count = 0;
        loop {
            while top > 0 && n[top - 1] == 0 {
                top -= 1;
            }
            if top == 0 {
                break;
            }
            let mut rem = 0u64;
            for limb in n[..top].iter_mut().rev() {
                let cur = (rem << 32) | u64::from(*limb);
                *limb = (cur / TEN_POW_9) as u32;
                rem = cur % TEN_POW_9;
            }
            chunks[count] = rem as u32;
            count += 1;
        }
        // Render all chunks into one buffer so the append is all-or-nothing.
        let mut digits = [b'0'; 81];
        let mut start = digits.len();
        for (i, chunk) in chunks[..count].iter().enumerate() {
            let mut chunk = *chunk;
            let mut written = 0;
            // Inner chunks are zero-padded to nine digits.
            while chunk != 0 || written == 0 || (i + 1 < count && written < 9) {
                start -= 1;
                digits[start] = b'0' + (chunk % 10) as u8;
                chunk /= 10;
                written += 1;
            }
        }
        self.push(&digits[start..])
    }

    /// Appends `0x` followed by `bytes` in lowercase hex, like `{:?}` on
    /// `H256` and `H160`.
    #[inline(never)]
    pub fn hex(&mut self, bytes: &[u8]) -> &mut Self {
        let end = self.len + 2 + 2 * bytes.len();
        if end > LOG_LINE_CAPACITY {
            return self;
        }
        let out = &mut self.buf[self.len..end];
        out[0] = b'0';
        out[1] = b'x';
        for (pair, b) in out[2..].chunks_exact_mut(2).zip(bytes) {
            pair[0] = HEX_DIGITS[usize::from(b >> 4)];
            pair[1] = HEX_DIGITS[usize::from(b & 0x0f)];
        }
        self.len = end;
        self
    }

    /// Appends `key` in base58, like `{}` on `Pubkey`.
    ///
    /// This goes through `Pubkey`'s `Display` (~1.8k CU, code shared with any
    /// other `{}` formatting of keys in the program) and is meant for cold
    /// paths. On hot paths use [`LogLine::log_with_keys`].
    #[inline(never)]
    pub fn pubkey(&mut self, key: &Pubkey) -> &mut Self {
        // `Pubkey`'s `Display` makes a single `write_str` call, which appends
        // all-or-nothing and never fails (see the `fmt::Write` impl).
        let _ = write!(self, "{}", key);
        self
    }

    /// The line built so far.
    pub fn as_str(&self) -> &str {
        let bytes = &self.buf[..self.len];
        // SAFETY: `push` is the only writer. It appends whole byte strings that
        // are either a full `&str` or ASCII digits/hex, or nothing, so `bytes`
        // is always valid UTF-8. Skipping `from_utf8` saves ~1.3 KB of program
        // code and a per-byte validation pass.
        #[allow(unsafe_code)]
        unsafe {
            core::str::from_utf8_unchecked(bytes)
        }
    }

    /// Emits the line with one `sol_log` syscall.
    #[inline(never)]
    pub fn log(&self) {
        sol_log(self.as_str());
    }

    /// Emits the line, then each key on its own line via `sol_log_pubkey`.
    /// Base58-encoding a key in-program costs ~1.4-1.8k CU; the syscall costs
    /// 100.
    #[inline(never)]
    pub fn log_with_keys(&self, keys: &[&Pubkey]) {
        self.log();
        for key in keys {
            key.log();
        }
    }
}

impl Write for LogLine {
    /// Appends `s` all-or-nothing. Never returns an error, so a dropped piece
    /// can't turn a log call into a failure.
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.str(s);
        Ok(())
    }
}

/// Writes `v` in decimal right-aligned into `out` and returns the index of
/// the first digit.
fn write_decimal(mut v: u64, out: &mut [u8; 20]) -> usize {
    let mut i = out.len();
    loop {
        i -= 1;
        out[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            return i;
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_core::{H160, H256, U256};

    fn line() -> LogLine {
        LogLine::new()
    }

    #[test]
    fn test_u64_matches_display() {
        for v in [
            0,
            1,
            9,
            10,
            42,
            69420,
            u64::from(u32::MAX),
            TEN_POW_9 - 1,
            TEN_POW_9,
            10_000_000_000_000_000_000,
            u64::MAX,
        ] {
            assert_eq!(line().u64(v).as_str(), format!("{}", v));
        }
    }

    #[test]
    fn test_u256_matches_display() {
        let ten = U256::from(10u64);
        let mut values = vec![
            U256::zero(),
            U256::one(),
            U256::from(u64::MAX),
            U256::from(u64::MAX) + 1,
            U256::from(TEN_POW_9),
            U256::from(1u128 << 64) * U256::from(TEN_POW_9),
            U256::from(69_000_000_000_000_000_000u128),
            U256::from(u128::MAX),
            U256::MAX,
            U256::MAX - 1,
        ];
        for exp in [
            9u64, 18, 19, 20, 27, 36, 38, 39, 45, 54, 57, 58, 63, 72, 76, 77,
        ] {
            let p = ten.pow(U256::from(exp));
            values.extend([p - 1, p, p + 1]);
        }
        // Pseudo-random values of every magnitude.
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        for i in 0..2000 {
            let mut limbs = [0u64; 4];
            for limb in limbs.iter_mut() {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                *limb = x;
            }
            values.push(U256(limbs) >> (i % 256));
        }
        for v in values {
            assert_eq!(line().u256(v.0).as_str(), format!("{}", v));
        }
    }

    #[test]
    fn test_hex_matches_h256_debug() {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(37).wrapping_add(0xa5);
        }
        for h in [H256::zero(), H256::repeat_byte(0xff), H256(bytes)] {
            assert_eq!(line().hex(h.as_bytes()).as_str(), format!("{:?}", h));
        }
        for h in [H160::zero(), H160::repeat_byte(0x5a)] {
            assert_eq!(line().hex(h.as_bytes()).as_str(), format!("{:?}", h));
        }
    }

    #[test]
    fn test_i64_bool_option_match_format() {
        for v in [0, 1, -1, 500, -500, i64::MAX, i64::MIN] {
            assert_eq!(line().i64(v).as_str(), format!("{}", v));
        }
        assert_eq!(line().bool(true).bool(false).as_str(), "truefalse");
        let key = Pubkey::new_unique();
        for v in [Some(key), None] {
            assert_eq!(
                line().option(v, |l, k| l.pubkey(&k)).as_str(),
                format!("{:?}", v)
            );
        }
        for v in [Some(200000u64), None] {
            assert_eq!(line().option(v, LogLine::u64).as_str(), format!("{:?}", v));
        }
        let h = H256::repeat_byte(0x32);
        assert_eq!(
            line().option(Some(h), |l, h| l.hex(h.as_bytes())).as_str(),
            format!("{:?}", Some(h))
        );
    }

    #[test]
    fn test_pubkey_matches_display() {
        for key in [
            Pubkey::default(),
            Pubkey::new_from_array([0xff; 32]),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ] {
            assert_eq!(line().pubkey(&key).as_str(), format!("{}", key));
        }
    }

    #[test]
    fn test_concatenation() {
        let id = H256::repeat_byte(0xab);
        assert_eq!(
            line()
                .str("Dispatched message to ")
                .u64(69420)
                .str(", ID ")
                .hex(id.as_bytes())
                .as_str(),
            format!("Dispatched message to {}, ID {:?}", 69420, id)
        );
    }

    #[test]
    fn test_overflow_drops_whole_pieces() {
        let mut l = line();
        let filler = "x".repeat(LOG_LINE_CAPACITY - 8);
        l.str(&filler).str("abc").str("—").str("defgh").u64(12345);
        // "abc" (3) + "—" (3 bytes) fit in the last 8 bytes; "defgh" and
        // "12345" (5 each) don't.
        assert_eq!(l.as_str(), format!("{filler}abc—"));
        l.u64(12).hex(&[0; 32]);
        assert_eq!(l.as_str(), format!("{filler}abc—12"));
    }
}
