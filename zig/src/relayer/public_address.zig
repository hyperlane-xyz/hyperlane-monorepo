//! The Rust CCIP public-egress policy. Validate the actual connected sockaddr,
//! not just the URL spelling, so DNS rebinding and numeric IPv4 forms cannot
//! reach metadata services, loopback, private or transition-network addresses.
const std = @import("std");

pub fn isPublic(address: std.net.Address) bool {
    return switch (address.any.family) {
        std.posix.AF.INET => ipv4(std.mem.asBytes(&address.in.sa.addr)[0..4].*),
        std.posix.AF.INET6 => ipv6(address.in6.sa.addr),
        else => false,
    };
}

pub fn ipv4(bytes: [4]u8) bool {
    const a = bytes[0];
    const b = bytes[1];
    const c = bytes[2];
    return !(a == 0 or a == 10 or a == 127 or a >= 224 or
        (a == 100 and b >= 64 and b <= 127) or
        (a == 169 and b == 254) or
        (a == 172 and b >= 16 and b <= 31) or
        (a == 192 and ((b == 0 and (c == 0 or c == 2)) or (b == 88 and c == 99) or b == 168)) or
        (a == 198 and ((b >= 18 and b <= 19) or (b == 51 and c == 100))) or
        (a == 203 and b == 0 and c == 113));
}

pub fn ipv6(bytes: [16]u8) bool {
    // Rust Ipv6Addr::to_ipv4 accepts mapped and compatible encodings.
    if (std.mem.allEqual(u8, bytes[0..12], 0) or
        (std.mem.allEqual(u8, bytes[0..10], 0) and bytes[10] == 255 and bytes[11] == 255)) return ipv4(bytes[12..16].*);
    return bytes[0] & 0xe0 == 0x20 and
        !((bytes[0] == 0x20 and bytes[1] == 0x01 and (bytes[2] == 0x00 or bytes[2] == 0x02)) or
            (bytes[0] == 0x20 and bytes[1] == 0x01 and bytes[2] == 0x0d and bytes[3] == 0xb8) or
            (bytes[0] == 0x20 and bytes[1] == 0x02) or
            (bytes[0] == 0x3f and bytes[1] == 0xff and bytes[2] & 0xf0 == 0));
}

test "CCIP public IP policy rejects private special-use and transition destinations" {
    for ([_][]const u8{
        "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::", "::ffff:7f00:1", "::7f00:1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "3fff::1",
    }) |text| try std.testing.expect(!isPublic(try std.net.Address.parseIp(text, 80)));
    for ([_][]const u8{ "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "2606:4700:4700::1111", "::ffff:808:808" }) |text| try std.testing.expect(isPublic(try std.net.Address.parseIp(text, 443)));
}
