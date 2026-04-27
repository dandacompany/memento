import type { ConflictGroup, ProviderId } from "./types.js";

interface MementoErrorOptions {
  hint?: string;
  exitCode?: number;
  cause?: unknown;
}

export class MementoError extends Error {
  code: string;
  hint?: string;
  exitCode: number;

  constructor(code: string, message: string, opts: MementoErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = "MementoError";
    this.code = code;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? 1;
  }
}

export class ConflictError extends MementoError {
  groups: ConflictGroup[];

  constructor(
    groups: ConflictGroup[],
    message = "Unresolved memory conflicts",
  ) {
    super("CONFLICT", message, {
      exitCode: 2,
      hint: "Resolve conflicts interactively or choose --strategy lww.",
    });
    this.name = "ConflictError";
    this.groups = groups;
  }
}

export class AdapterError extends MementoError {
  providerId: ProviderId;
  phase: "read" | "write" | "probe";

  constructor(
    providerId: ProviderId,
    phase: "read" | "write" | "probe",
    code: string,
    message: string,
    opts: MementoErrorOptions = {},
  ) {
    super(code, message, {
      ...opts,
      exitCode: opts.exitCode ?? 1,
    });
    this.name = "AdapterError";
    this.providerId = providerId;
    this.phase = phase;
  }
}
