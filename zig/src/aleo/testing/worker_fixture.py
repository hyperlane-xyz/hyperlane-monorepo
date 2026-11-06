#!/usr/bin/env python3
"""Disposable framed process fault oracle. No VM, keys, files or network."""
import os
import struct
import sys
import time

while True:
    prefix = sys.stdin.buffer.read(4)
    if not prefix:
        break
    length, = struct.unpack(">I", prefix)
    wire = sys.stdin.buffer.read(length)
    if len(wire) != length:
        break
    payload = wire[1:]
    if payload == b"sleep":
        time.sleep(60)
    elif payload == b"partial":
        os.write(1, b"\0\0")
        time.sleep(60)
    elif payload == b"oversize":
        os.write(1, struct.pack(">IB", 0x7FFFFFFF, 0))
        time.sleep(60)
    elif payload == b"memory":
        allocation = bytearray(96 * 1024 * 1024)
        for offset in range(0, len(allocation), 4096):
            allocation[offset] = 1
        time.sleep(60)
    elif payload == b"reject":
        os.write(1, struct.pack(">IBH", 3, 1, 42))
    elif payload == b"crash":
        os._exit(9)
    else:
        os.write(1, struct.pack(">IB", len(payload) + 1, 0) + payload)
