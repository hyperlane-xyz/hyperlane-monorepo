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
	_ = b[7]
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
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
