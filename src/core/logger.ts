export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  startSpinner: (text: string) => void;
  stopSpinner: (text?: string) => void;
}

export type LoggerMode = "tty" | "non-tty" | "json";

interface LoggerOptions {
  mode?: LoggerMode;
  debug?: boolean;
  quiet?: boolean;
}

type LogLevel = "info" | "warn" | "error" | "debug" | "success";

const colors = {
  cyan: (input: string) => input,
  green: (input: string) => input,
  red: (input: string) => input,
  yellow: (input: string) => input,
  dim: (input: string) => input,
};

function serializeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }

      if (arg instanceof Error) {
        return arg.message;
      }

      return JSON.stringify(arg);
    })
    .join(" ");
}

function writeJson(level: LogLevel, args: unknown[]): void {
  const payload = {
    level,
    message: serializeArgs(args),
    args,
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const mode: LoggerMode =
    opts.mode ?? (process.stdout.isTTY ? "tty" : "non-tty");
  const debugEnabled = opts.debug ?? false;
  const quiet = opts.quiet ?? false;
  let spinnerText: string | null = null;

  function emit(level: LogLevel, args: unknown[]): void {
    if (quiet && level !== "error") {
      return;
    }

    if (level === "debug" && !debugEnabled) {
      return;
    }

    if (mode === "json") {
      writeJson(level, args);
      return;
    }

    const message = serializeArgs(args);
    const prefixByLevel: Record<LogLevel, string> = {
      info: colors.cyan("info"),
      warn: colors.yellow("warn"),
      error: colors.red("error"),
      debug: colors.dim("debug"),
      success: colors.green("success"),
    };
    const stream =
      level === "error" || level === "warn" ? process.stderr : process.stdout;

    stream.write(`${prefixByLevel[level]} ${message}\n`);
  }

  return {
    info: (...args: unknown[]) => emit("info", args),
    warn: (...args: unknown[]) => emit("warn", args),
    error: (...args: unknown[]) => emit("error", args),
    debug: (...args: unknown[]) => emit("debug", args),
    success: (...args: unknown[]) => emit("success", args),
    startSpinner: (text: string) => {
      spinnerText = text;

      if (quiet) {
        return;
      }

      if (mode === "json") {
        writeJson("info", [text]);
        return;
      }

      if (mode === "tty") {
        process.stdout.write(`${text}\n`);
      }
    },
    stopSpinner: (text?: string) => {
      const finalText = text ?? spinnerText;
      spinnerText = null;

      if (!finalText || quiet) {
        return;
      }

      if (mode === "json") {
        writeJson("success", [finalText]);
        return;
      }

      if (mode === "tty") {
        process.stdout.write(`${finalText}\n`);
      }
    },
  };
}
