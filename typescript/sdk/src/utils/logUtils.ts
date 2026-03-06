import { Interface, LogDescription } from 'ethers';

export type ParsableLog = {
  address: string;
  topics: readonly string[];
  data: string;
};

export function findMatchingLogEvents(
  logs: readonly ParsableLog[],
  iface: Interface,
  eventName: string,
): LogDescription[] {
  return logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return undefined;
      }
    })
    .filter((log): log is LogDescription => !!log && log.name === eventName);
}
