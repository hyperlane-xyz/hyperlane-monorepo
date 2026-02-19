import type { MonitorEvent } from '../../interfaces/IMonitor.js';
import { MonitorEventType } from '../../interfaces/IMonitor.js';
import type { Monitor } from '../../monitor/Monitor.js';

export async function getFirstMonitorEvent(
  monitor: Monitor,
): Promise<MonitorEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Monitor event timeout'));
    }, 60_000);

    monitor.on(MonitorEventType.TokenInfo, (event: MonitorEvent) => {
      clearTimeout(timeout);
      void monitor.stop();
      resolve(event);
    });

    monitor.on(MonitorEventType.Error, (error: Error) => {
      clearTimeout(timeout);
      void monitor.stop();
      reject(error);
    });

    void monitor.start();
  });
}
