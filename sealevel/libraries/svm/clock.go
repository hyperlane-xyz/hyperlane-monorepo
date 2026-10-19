package svm

import "gosvm/solana"

// Clock is the Clock sysvar (solana_program::clock::Clock).
type Clock struct {
	Slot                uint64
	EpochStartTimestamp int64
	Epoch               uint64
	LeaderScheduleEpoch uint64
	UnixTimestamp       int64
}

func le64(b []byte) uint64 {
	v := uint64(0)
	for i := 0; i < 8; i++ {
		v |= uint64(b[i]) << (8 * uint64(i))
	}
	return v
}

// GetClock is Clock::get(). A failed sysvar read is UnsupportedSysvar.
func GetClock(c solana.Context) (Clock, uint64) {
	var b [40]byte
	if solana.Clock(c, b[:]) != 0 {
		return Clock{}, UnsupportedSysvar
	}
	return Clock{
		Slot:                le64(b[0:8]),
		EpochStartTimestamp: int64(le64(b[8:16])),
		Epoch:               le64(b[16:24]),
		LeaderScheduleEpoch: le64(b[24:32]),
		UnixTimestamp:       int64(le64(b[32:40])),
	}, Success
}
