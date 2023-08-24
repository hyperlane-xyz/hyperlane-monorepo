export function median(a: number[]): number {
  const sorted = a.slice().sort();
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 == 0 ? (sorted[mid] + sorted[mid + 1]) / 2 : sorted[mid];
  return median;
}

export function sum(a: number[]): number {
  return a.reduce((acc, i) => acc + i);
}

export function mean(a: number[]): number {
  return sum(a) / a.length;
}

export function stdDev(a: number[]): number {
  const xbar = mean(a);
  const squaredDifferences = a.map((x) => Math.pow(x - xbar, 2));
  return Math.sqrt(mean(squaredDifferences));
}
