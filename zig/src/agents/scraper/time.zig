const std = @import("std");
/// Checked RFC3339 seconds for UTC chain headers; subsecond precision is
/// intentionally discarded by the production scraper block schema.
pub fn rfc3339(text: []const u8) !u64 {
    if (text.len < 20 or text[4] != '-' or text[7] != '-' or text[10] != 'T' or text[13] != ':' or text[16] != ':') return error.InvalidChainTimestamp;
    const year = try number(text[0..4]);
    const month = try number(text[5..7]);
    const day = try number(text[8..10]);
    const hour = try number(text[11..13]);
    const minute = try number(text[14..16]);
    const second = try number(text[17..19]);
    if (year < 1970 or month == 0 or month > 12 or day == 0 or hour > 23 or minute > 59 or second > 59) return error.InvalidChainTimestamp;
    if (day > std.time.epoch.getDaysInMonth(@intCast(year), @enumFromInt(month))) return error.InvalidChainTimestamp;
    var end: usize = 19;
    if (text[end] == '.') {
        end += 1;
        const start = end;
        while (end < text.len and std.ascii.isDigit(text[end])) : (end += 1) {}
        if (end == start or end - start > 9) return error.InvalidChainTimestamp;
    }
    var offset: i64 = 0;
    if (end >= text.len) return error.InvalidChainTimestamp;
    if (text[end] == 'Z') {
        if (end + 1 != text.len) return error.InvalidChainTimestamp;
    } else {
        if (end + 6 != text.len or (text[end] != '+' and text[end] != '-') or text[end + 3] != ':') return error.InvalidChainTimestamp;
        const hours = try number(text[end + 1 .. end + 3]);
        const minutes = try number(text[end + 4 .. end + 6]);
        if (hours > 23 or minutes > 59) return error.InvalidChainTimestamp;
        offset = @as(i64, hours) * 3600 + @as(i64, minutes) * 60;
        if (text[end] == '-') offset = -offset;
    }
    var days: i64 = @as(i64, year - 1970) * 365 + leaps(year - 1) - leaps(1969);
    var m: u16 = 1;
    while (m < month) : (m += 1) days += std.time.epoch.getDaysInMonth(@intCast(year), @enumFromInt(m));
    days += day - 1;
    return std.math.cast(u64, days * 86400 + @as(i64, hour) * 3600 + @as(i64, minute) * 60 + second - offset) orelse error.InvalidChainTimestamp;
}
fn number(text: []const u8) !u16 {
    for (text) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidChainTimestamp;
    return std.fmt.parseInt(u16, text, 10);
}
fn leaps(year: u16) i64 {
    return @as(i64, year / 4) - year / 100 + year / 400;
}
test "scraper header timestamp handles leap days fractions offsets and invalid dates" {
    try std.testing.expectEqual(@as(u64, 1700000000), try rfc3339("2023-11-14T22:13:20.123456789Z"));
    try std.testing.expectEqual(@as(u64, 1700000000), try rfc3339("2023-11-14T23:13:20+01:00"));
    try std.testing.expectEqual(@as(u64, 951782400), try rfc3339("2000-02-29T00:00:00Z"));
    for ([_][]const u8{ "2023-02-29T00:00:00Z", "2024-13-01T00:00:00Z", "2024-01-01T24:00:00Z", "1970-01-01T00:00:00+01:00", "2024-01-01T00:00:00.Z" }) |invalid| try std.testing.expectError(error.InvalidChainTimestamp, rfc3339(invalid));
}
