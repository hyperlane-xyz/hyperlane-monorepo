import { FSWatcher, watch as fsWatch } from 'fs';

export interface IWatcher {
  watch(path: string, callback: () => any): void;
  stop(): void;
}

export class FileSystemRegistryWatcher implements IWatcher {
  private watcher: FSWatcher | undefined;

  watch(path: string, callback: () => any) {
    if (!this.watcher)
      this.watcher = fsWatch(path, { recursive: true }, (event, filename) => {
        // For now we just watch for yaml and json files
        if (filename?.match(/\.(yaml|json)$/)) {
          callback();
        }
      });
  }

  stop() {
    if (this.watcher) this.watcher.close();
  }
}
