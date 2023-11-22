export function getTimestampForFilename() {
  const pad = (n: number) =>
    n.toLocaleString('en-US', { minimumIntegerDigits: 2, useGrouping: false });
  const now = new Date();
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const date = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${year}-${month}-${date}-${hours}-${minutes}-${seconds}`;
}
