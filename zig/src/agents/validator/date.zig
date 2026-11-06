const std = @import("std");
pub fn amzDate(buffer: *[16]u8, seconds: u64) ![]const u8 {
    if (seconds > 253402300799) return error.InvalidClock;
    const epoch: std.time.epoch.EpochSeconds = .{ .secs = seconds };
    const year = epoch.getEpochDay().calculateYearDay();
    const month = year.calculateMonthDay();
    const day = epoch.getDaySeconds();
    if (year.year > 9999) return error.InvalidClock;
    return std.fmt.bufPrint(buffer, "{d:0>4}{d:0>2}{d:0>2}T{d:0>2}{d:0>2}{d:0>2}Z", .{ year.year, @intFromEnum(month.month), month.day_index + 1, day.getHoursIntoDay(), day.getMinutesIntoHour(), day.getSecondsIntoMinute() });
}
