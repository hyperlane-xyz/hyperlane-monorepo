import { Interface, Log as EthersLog, LogDescription } from 'ethers';
import { Log } from 'viem';

export function findMatchingLogEvents(
  logs: readonly (EthersLog | Log<bigint, number, false>)[],
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
    .filter(
      (log): log is LogDescription => !!log && log.name === eventName,
    );
}
