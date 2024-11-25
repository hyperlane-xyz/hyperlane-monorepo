import { ethers } from 'ethers';
import { Log } from 'viem';

export function findMatchingLogEvents(
  logs: (ethers.providers.Log | Log<bigint, number, false>)[],
  iface: ethers.utils.Interface,
  eventName: string,
): ethers.utils.LogDescription[] {
  return logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return undefined;
      }
    })
    .filter(
      (log): log is ethers.utils.LogDescription =>
        !!log && log.name === eventName,
    );
}
