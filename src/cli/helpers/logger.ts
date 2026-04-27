import {
  createLogger,
  type Logger,
  type LoggerMode,
} from "../../core/logger.js";

export function loggerFromOpts(opts: {
  debug?: boolean;
  json?: boolean;
  quiet?: boolean;
}): Logger {
  const mode: LoggerMode = opts.json
    ? "json"
    : process.stdout.isTTY
      ? "tty"
      : "non-tty";

  return createLogger({
    mode,
    debug: opts.debug ?? false,
    quiet: opts.quiet ?? false,
  });
}
