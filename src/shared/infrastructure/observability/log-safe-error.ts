import { DomainError } from "../../domain/domain-error";

export function describeError(error: unknown): { error: string; code?: string; stack?: string } {
  if (error instanceof DomainError) return { error: error.name, code: error.code };
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { error: error.name, code: typeof code === "string" ? code : undefined };
  }
  return { error: typeof error };
}

export function describeUnexpectedError(error: unknown): { error: string; code?: string; stack?: string } {
  const frames = error instanceof Error ? (error.stack ?? "").split("\n").filter((line) => line.trim().startsWith("at ")) : [];
  return { ...describeError(error), stack: frames.slice(0, 15).join("\n") || undefined };
}
