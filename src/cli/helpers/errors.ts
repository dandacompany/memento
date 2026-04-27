import { MementoError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";

export function handleCliError(
  err: unknown,
  logger: Logger,
  debug: boolean,
): number {
  if (err instanceof MementoError) {
    logger.error(err.message);

    if (err.hint) {
      logger.error(`Hint: ${err.hint}`);
    }

    return err.exitCode;
  }

  if (err instanceof Error) {
    logger.error(debug ? (err.stack ?? err.message) : err.message);
    return 1;
  }

  logger.error(String(err));
  return 1;
}
