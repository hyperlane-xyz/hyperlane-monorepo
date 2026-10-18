// Package solana is the narrow host/SBF boundary for the experiment.
// Context fields are available to native tests; SBF source may only pass Context
// to the functions below, never inspect its fields or construct one.
package solana

type Account struct {
	Key, Owner, Data             []byte
	Signer, Writable, Executable bool
	Lamports                     uint64
	OriginalDataLen              uint64 // Native lifecycle tests set the invocation-entry length.
}

type Context struct {
	Accounts            []Account
	InstructionData, ID []byte
	Invoke              func(program, source, destination, authority, amount uint64, seed []byte, bump byte) uint64
	CheckPDA            func(account uint64, seed []byte, bump byte) bool
	Hash                func(input []byte) []byte
	InvokeInstruction   func(program uint64, metas, data, signerSeeds []byte) uint64
	DeriveAddress       func(seeds, program, output []byte) uint64
	ReadRent            func(output []byte) uint64                                              // Canonical 17-byte rate/threshold-bits/burn encoding.
	ReadClock           func(output []byte) uint64                                              // Canonical five-word Clock encoding; signed timestamps are raw bits.
	WriteReturnData     func(data []byte)                                                       // Native callback receives an owned copy; CPI callbacks model clearing.
	ReadReturnData      func() (data, program []byte)                                           // Current return data and its setter; nil reads as none.
	RecoverSecp256k1    func(hash []byte, recoveryID uint64, signature []byte) ([]byte, uint64) // 64-byte key or runtime status.
	Keccak              func(input []byte) []byte                                               // Keccak-256 with the original 0x01 padding (not SHA3-256).
}

// SetReturnData copies at most 1,024 bytes into the runtime's current return
// data. Empty data clears it. Set it after CPIs, which clear prior return data.
// Native adapters model program identity and CPI/reset semantics in callbacks.
func SetReturnData(c Context, data []byte) uint64 {
	if len(data) > 1024 {
		return 2017
	}
	if c.WriteReturnData == nil {
		return 2009
	}
	owned := make([]byte, len(data))
	copy(owned, data)
	c.WriteReturnData(owned)
	return 0
}

// GetReturnData reads the current return data: the bytes most recently set by
// this program or by a program it invoked. It returns the full size (at most
// 1,024; zero when there is none) and copies min(len(output), size) bytes into
// output. When it copies at least one byte it also writes the setting program's
// key into program; otherwise both are unchanged. A size above len(output)
// means output holds a prefix. Check the setter before trusting the bytes: a
// CPI that sets nothing leaves earlier return data in place. program must be
// exactly 32 bytes; any other length traps.
func GetReturnData(c Context, output, program []byte) uint64 {
	if len(program) != 32 {
		panic("gosvm/solana: GetReturnData program is not 32 bytes")
	}
	if c.ReadReturnData == nil {
		return 0
	}
	data, setter := c.ReadReturnData()
	n := len(data)
	if n > len(output) {
		n = len(output)
	}
	if n != 0 {
		copy(output[:n], data)
		copy(program, setter)
	}
	return uint64(len(data))
}

// Clock writes exactly 40 bytes: slot, epoch-start timestamp bits, epoch,
// leader-schedule epoch and Unix timestamp bits, each little-endian uint64.
// Timestamp words preserve the runtime's two's-complement int64 representation.
// Failed reads preserve output. Applications decide which timestamps are valid.
func Clock(c Context, output []byte) uint64 {
	if len(output) != 40 {
		return 2016
	}
	if c.ReadClock == nil {
		return 2009
	}
	var data [40]byte
	code := c.ReadClock(data[:])
	if code != 0 {
		return code
	}
	for j := 0; j < 40; j++ {
		output[j] = data[j]
	}
	return 0
}

// Rent writes rate:uint64, IEEE-754 threshold bits:uint64 (both little-endian),
// and burn-percent:byte from the runtime sysvar. Failed reads preserve output.
func Rent(c Context, output []byte) uint64 {
	if len(output) != 17 {
		return 2015
	}
	if c.ReadRent == nil {
		return 2009
	}
	var data [17]byte
	code := c.ReadRent(data[:])
	if code != 0 {
		return code
	}
	for j := 0; j < 17; j++ {
		output[j] = data[j]
	}
	return 0
}

func ownedWritable(c Context, index uint64) uint64 {
	if index >= uint64(len(c.Accounts)) {
		return 2005
	}
	a := c.Accounts[index]
	if !a.Writable || a.Executable {
		return 2011
	}
	if len(a.Owner) != 32 || len(c.ID) != 32 {
		return 2012
	}
	for j := 0; j < 32; j++ {
		if a.Owner[j] != c.ID[j] {
			return 2012
		}
	}
	return 0
}

// ResizeAccount changes an owned writable account's current data length, zero
// extending growth. Its original invocation length bounds the 10 KiB increase.
// Native tests supply OriginalDataLen; SBF records the loader's initial length.
func ResizeAccount(c Context, index, length uint64) uint64 {
	code := ownedWritable(c, index)
	if code != 0 {
		return code
	}
	a := c.Accounts[index]
	if len(a.Key) != 32 {
		return 2013
	}
	if a.OriginalDataLen > 10485760 || length > 10485760 || length > a.OriginalDataLen+10240 {
		return 2010
	}
	data := make([]byte, length)
	copy(data, a.Data)
	for j := range c.Accounts {
		other := &c.Accounts[j]
		if len(other.Key) != 32 || len(a.Key) != 32 {
			continue
		}
		same := true
		for k := 0; k < 32; k++ {
			if other.Key[k] != a.Key[k] {
				same = false
			}
		}
		if same {
			other.Data = data[:len(data):len(data)]
		}
	}
	return 0
}

// CloseAccount refunds lamports, truncates data and assigns the System owner.
// Application/schema checks must authorize both source and refund destination.
func CloseAccount(c Context, index, destination uint64) uint64 {
	code := ownedWritable(c, index)
	if code != 0 {
		return code
	}
	if destination >= uint64(len(c.Accounts)) {
		return 2005
	}
	a, b := c.Accounts[index], c.Accounts[destination]
	if !b.Writable || b.Executable {
		return 2011
	}
	if len(a.Key) != 32 || len(b.Key) != 32 {
		return 2013
	}
	same := true
	for j := 0; j < 32; j++ {
		if a.Key[j] != b.Key[j] {
			same = false
		}
	}
	if same {
		return 2013
	}
	if a.Lamports > ^uint64(0)-b.Lamports {
		return 2014
	}
	if a.OriginalDataLen > 10485760 {
		return 2010
	}
	code = ResizeAccount(c, index, 0)
	if code != 0 {
		return code
	}
	for j := range c.Accounts {
		other := &c.Accounts[j]
		if len(other.Key) != 32 {
			continue
		}
		left, right := true, true
		for k := 0; k < 32; k++ {
			if other.Key[k] != a.Key[k] {
				left = false
			}
			if other.Key[k] != b.Key[k] {
				right = false
			}
		}
		if left {
			other.Lamports = 0
			other.Owner = make([]byte, 32)
		}
		if right {
			other.Lamports = a.Lamports + b.Lamports
		}
	}
	return 0
}

// SHA256 hashes an explicitly bounded region into 32 bytes of output. SBF uses
// the runtime syscall; native tests supply the standard library implementation.
func SHA256(c Context, input []byte, offset, length uint64, output []byte, outOffset uint64) uint64 {
	if offset > uint64(len(input)) || length > uint64(len(input))-offset || outOffset > uint64(len(output)) || uint64(len(output))-outOffset < 32 {
		return 2003
	}
	h := c.Hash(input[offset : offset+length])
	if len(h) != 32 {
		return 2004
	}
	for i := uint64(0); i < 32; i++ {
		output[outOffset+i] = h[i]
	}
	return 0
}

// Secp256k1Recover recovers the uncompressed secp256k1 public key, without its
// 0x04 prefix, that produced a 64-byte r||s signature of a 32-byte hash, and
// writes it to the 64-byte output. recoveryID is 0-3 (Ethereum's v-27). Wrong
// lengths return 2018 without a syscall; otherwise the runtime's status
// propagates: 2 invalid recovery ID, 3 invalid signature. Failures leave output
// unchanged. Recovery alone does not authenticate a signer: compare the result
// with an expected key or address.
func Secp256k1Recover(c Context, hash []byte, recoveryID uint64, signature, output []byte) uint64 {
	if len(hash) != 32 || len(signature) != 64 || len(output) != 64 {
		return 2018
	}
	if c.RecoverSecp256k1 == nil {
		return 2009
	}
	key, code := c.RecoverSecp256k1(hash, recoveryID, signature)
	if code != 0 {
		return code
	}
	if len(key) != 64 {
		return 2018
	}
	copy(output, key)
	return 0
}

// Keccak256 hashes an explicitly bounded region with Keccak-256, as Ethereum
// does (the original 0x01 padding, not SHA3-256), into 32 bytes of output.
// Bounds follow SHA256: 2003 for a range outside input or output, without a
// syscall. SBF uses the runtime syscall; native tests supply Keccak, and a
// missing callback returns 2009.
func Keccak256(c Context, input []byte, offset, length uint64, output []byte, outOffset uint64) uint64 {
	if offset > uint64(len(input)) || length > uint64(len(input))-offset || outOffset > uint64(len(output)) || uint64(len(output))-outOffset < 32 {
		return 2003
	}
	if c.Keccak == nil {
		return 2009
	}
	h := c.Keccak(input[offset : offset+length])
	if len(h) != 32 {
		return 2004
	}
	for i := uint64(0); i < 32; i++ {
		output[outOffset+i] = h[i]
	}
	return 0
}

func Count(c Context) uint64                                 { return uint64(len(c.Accounts)) }
func Data(c Context, i uint64) []byte                        { return c.Accounts[i].Data }
func Key(c Context, i uint64) []byte                         { return c.Accounts[i].Key }
func Owner(c Context, i uint64) []byte                       { return c.Accounts[i].Owner }
func Signer(c Context, i uint64) bool                        { return c.Accounts[i].Signer }
func Writable(c Context, i uint64) bool                      { return c.Accounts[i].Writable }
func Executable(c Context, i uint64) bool                    { return c.Accounts[i].Executable }
func Instruction(c Context) []byte                           { return c.InstructionData }
func ProgramID(c Context) []byte                             { return c.ID }
func IsPDA(c Context, i uint64, seed []byte, bump byte) bool { return c.CheckPDA(i, seed, bump) }
func Transfer(c Context, program, source, destination, authority, amount uint64) uint64 {
	return c.Invoke(program, source, destination, authority, amount, nil, 0)
}
func TransferSigned(c Context, program, source, destination, authority, amount uint64, seed []byte, bump byte) uint64 {
	return c.Invoke(program, source, destination, authority, amount, seed, bump)
}
func IsTokenProgram(c Context, i uint64) bool {
	key := c.Accounts[i].Key
	id := [32]byte{6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169}
	if len(key) != 32 || !c.Accounts[i].Executable {
		return false
	}
	for j := 0; j < 32; j++ {
		if key[j] != id[j] {
			return false
		}
	}
	return true
}

// Lamports reads the current balance, including changes made by a prior CPI.
func Lamports(c Context, i uint64) uint64 { return c.Accounts[i].Lamports }

// Invoke marshals one CPI using bounded encoded account metas and signer seed
// groups. Applications should use sdk/cpi builders instead of assembling these
// encodings. Meta records are index:uint64 LE and flags:byte (writable=1,
// signer=2). Signer groups are count:byte, then seed-count:byte followed by each
// length:byte and its bytes. Limits: 16 metas, 2 groups, 16 seeds/group, 32/seed.
func Invoke(c Context, program uint64, metas, data, signerSeeds []byte) uint64 {
	if program >= uint64(len(c.Accounts)) {
		return 2005
	}
	if !c.Accounts[program].Executable {
		return 2001
	}
	if len(metas)%9 != 0 || len(metas) > 16*9 {
		return 2006
	}
	for off := 0; off < len(metas); off += 9 {
		index := uint64(0)
		for j := 0; j < 8; j++ {
			index |= uint64(metas[off+j]) << uint(j*8)
		}
		if index >= uint64(len(c.Accounts)) || metas[off+8] > 3 {
			return 2006
		}
	}
	if len(data) > 10240 {
		return 2008
	}
	if !validSignerSeeds(signerSeeds) {
		return 2007
	}
	if c.InvokeInstruction == nil {
		return 2009
	}
	return c.InvokeInstruction(program, metas, data, signerSeeds)
}

func validSeedGroup(b []byte, off int) (int, bool) {
	if off >= len(b) || b[off] > 16 {
		return off, false
	}
	count := int(b[off])
	off++
	for i := 0; i < count; i++ {
		if off >= len(b) || b[off] > 32 {
			return off, false
		}
		n := int(b[off])
		off++
		if n > len(b)-off {
			return off, false
		}
		off += n
	}
	return off, true
}

func validSignerSeeds(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	if len(b) > 1024 || b[0] > 2 {
		return false
	}
	off := 1
	for i := 0; i < int(b[0]); i++ {
		var ok bool
		off, ok = validSeedGroup(b, off)
		if !ok {
			return false
		}
	}
	return off == len(b)
}

// CreateAddress derives an off-curve PDA with an explicit derivation program.
// seeds is one encoded seed group, normally produced by sdk/pda.Seeds.Bytes.
// The output is exactly 32 bytes; the syscall's exact nonzero status propagates.
func CreateAddress(c Context, seeds, program, output []byte) uint64 {
	if len(program) != 32 || len(output) != 32 || len(seeds) > 529 {
		return 2007
	}
	off, ok := validSeedGroup(seeds, 0)
	if !ok || off != len(seeds) {
		return 2007
	}
	if c.DeriveAddress == nil {
		return 2009
	}
	var address [32]byte
	code := c.DeriveAddress(seeds, program, address[:])
	if code != 0 {
		return code
	}
	for j := 0; j < 32; j++ {
		output[j] = address[j]
	}
	return 0
}
