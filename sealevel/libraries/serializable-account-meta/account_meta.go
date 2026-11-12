// Package accountmeta ports rust/sealevel/libraries/serializable-account-meta.
package accountmeta

import (
	"github.com/hyperlane-xyz/hyperlane-monorepo/sealevel/libraries/borsh"
)

// SerializableAccountMeta is a Borsh AccountMeta: pubkey, is_signer, is_writable.
type SerializableAccountMeta struct {
	Pubkey     [32]byte
	IsSigner   bool
	IsWritable bool
}

// Readonly is AccountMeta::new_readonly(key, signer).
func Readonly(key [32]byte, signer bool) SerializableAccountMeta {
	return SerializableAccountMeta{Pubkey: key, IsSigner: signer}
}

// Writable is AccountMeta::new(key, signer).
func Writable(key [32]byte, signer bool) SerializableAccountMeta {
	return SerializableAccountMeta{Pubkey: key, IsSigner: signer, IsWritable: true}
}

func (m *SerializableAccountMeta) EncodeBorsh(w *borsh.Writer) {
	w.Bytes32(m.Pubkey)
	w.Bool(m.IsSigner)
	w.Bool(m.IsWritable)
}

func (m *SerializableAccountMeta) DecodeBorsh(r *borsh.Reader) {
	m.Pubkey = r.Bytes32()
	m.IsSigner = r.Bool()
	m.IsWritable = r.Bool()
}

// WriteMetas writes a Vec<SerializableAccountMeta>.
func WriteMetas(w *borsh.Writer, metas []SerializableAccountMeta) {
	w.Len32(len(metas))
	for i := range metas {
		metas[i].EncodeBorsh(w)
	}
}

// ReadMetas reads a Vec<SerializableAccountMeta>.
func ReadMetas(r *borsh.Reader) []SerializableAccountMeta {
	return borsh.ReadVec(r, func(r *borsh.Reader) SerializableAccountMeta {
		var m SerializableAccountMeta
		m.DecodeBorsh(r)
		return m
	})
}

// SimulationReturnDataTrailer is SimulationReturnData's trailing_byte (u8::MAX),
// which keeps simulated return data from ending in a zero byte.
const SimulationReturnDataTrailer = 0xff

// EndSimulationReturnData appends the trailing byte after the payload, making
// w's contents a SimulationReturnData<T>.
func EndSimulationReturnData(w *borsh.Writer) { w.U8(SimulationReturnDataTrailer) }

// EncodeMetasReturnData is borsh(SimulationReturnData::new(metas)).
func EncodeMetasReturnData(metas []SerializableAccountMeta) []byte {
	w := borsh.NewWriter(4 + 34*len(metas) + 1)
	WriteMetas(&w, metas)
	EndSimulationReturnData(&w)
	return w.Bytes()
}

// DecodeMetasReturnData decodes SimulationReturnData<Vec<SerializableAccountMeta>>.
func DecodeMetasReturnData(b []byte) ([]SerializableAccountMeta, bool) {
	r := borsh.NewReader(b)
	metas := ReadMetas(&r)
	r.U8()
	return metas, r.Done()
}
