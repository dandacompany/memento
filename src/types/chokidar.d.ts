declare module "chokidar" {
  export interface FSWatcher {
    on(eventName: string, listener: (...args: unknown[]) => void): FSWatcher;
    close(): Promise<void> | void;
  }

  export interface WatchOptions {
    ignoreInitial?: boolean;
  }

  export function watch(
    paths: string | readonly string[],
    options?: WatchOptions,
  ): FSWatcher;
}
