import { FSWatcher, watch as fsWatch } from 'fs';

export interface IWatcher {
  watch(
    path: string,
    callback: () => any,
    onError?: (err: Error) => void,
  ): void;
  stop(): void;
}

export class FileSystemRegistryWatcher implements IWatcher {
  private watcher: FSWatcher | undefined;

  watch(path: string, callback: () => any, onError?: (err: Error) => void) {
    if (!this.watcher) {
      this.watcher = fsWatch(path, { recursive: true }, (event, filename) => {
        // For now we just watch for yaml, yml and json files
        if (filename?.match(/\.(ya?ml|json)$/i)) {
          callback();
        }
      });

      if (onError) {
        this.watcher.on('error', (err) => {
          this.stop();
          onError(err);
        });
      }
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
