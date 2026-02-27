import { Log } from 'viem';

type LogLike = { data: string; topics: readonly string[] };
type ParsedLog = { name: string };
type LogParser = {
  parseLog(log: LogLike | Log<bigint, number, false>): ParsedLog;
};

export function findMatchingLogEvents(
  logs: (LogLike | Log<bigint, number, false>)[],
  iface: LogParser,
  eventName: string,
): ParsedLog[] {
  return logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return undefined;
      }
    })
    .filter((log): log is ParsedLog => !!log && log.name === eventName);
}
