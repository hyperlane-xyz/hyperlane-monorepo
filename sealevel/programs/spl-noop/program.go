// Package splnoop stands in for the SPL Noop program
// (noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV) when the Rust functional
// suites run against ELFs: SBF_OUT_DIR makes solana-program-test load every
// program from .so files, including spl_noop. Not a port; not deployed.
package splnoop

import "gosvm/solana"

// Process accepts any instruction.
func Process(c solana.Context) uint64 { return 0 }
