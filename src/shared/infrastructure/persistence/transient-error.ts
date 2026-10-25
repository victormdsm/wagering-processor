import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  OptimisticLockError,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";

const TRANSIENT_TYPES = [
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  OptimisticLockError,
  UniqueConstraintViolationException,
];

const TRANSIENT_SQLSTATE = /^(08...|57P0[123]|53300)$/;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const POOL_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|connection error/i;

export function isTransientInfrastructureError(error: unknown): boolean {
  if (TRANSIENT_TYPES.some((type) => error instanceof type)) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (NETWORK_CODES.has(code) || TRANSIENT_SQLSTATE.test(code))) return true;
  return POOL_MESSAGES.test(error.message);
}
