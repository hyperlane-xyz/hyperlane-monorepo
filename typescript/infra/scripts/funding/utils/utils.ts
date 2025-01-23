export function formatDailyBurn(dailyBurn: number) {
  return dailyBurn < 1
    ? Number(dailyBurn.toFixed(3))
    : Number(dailyBurn.toPrecision(3));
}
