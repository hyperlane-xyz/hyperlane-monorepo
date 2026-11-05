"""Probe real Linux PMU counters; do not substitute time for CPU cycles."""

import ctypes
import errno
import fcntl
import json
import os
import platform
import struct


machine = platform.machine()
syscall_number = {"x86_64": 298, "aarch64": 241}[machine]
libc = ctypes.CDLL(None, use_errno=True)
results = {}
for name, config in [("cycles", 0), ("instructions", 1)]:
    attr = bytearray(128)
    struct.pack_into("IIQ", attr, 0, 0, len(attr), config)
    # disabled, exclude kernel, exclude hypervisor
    struct.pack_into("Q", attr, 40, 1 | (1 << 5) | (1 << 6))
    buffer = ctypes.create_string_buffer(bytes(attr))
    fd = libc.syscall(syscall_number, ctypes.byref(buffer), 0, -1, -1, 0)
    if fd < 0:
        code = ctypes.get_errno()
        results[name] = {"available": False, "errno": code, "error": errno.errorcode.get(code, str(code))}
        continue
    try:
        fcntl.ioctl(fd, 0x2403, 0)
        fcntl.ioctl(fd, 0x2400, 0)
        value = sum(i * i for i in range(100_000))
        fcntl.ioctl(fd, 0x2401, 0)
        count = struct.unpack("Q", os.read(fd, 8))[0]
        results[name] = {"available": count > 0, "count": count, "check": value}
    finally:
        os.close(fd)

print(json.dumps({"machine": machine, "counters": results}, indent=2))
