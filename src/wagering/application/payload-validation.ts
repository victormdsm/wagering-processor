import { isUuid } from "../../shared/application/uuid";
import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";
import { KindNotAllowedError, ReferenceRequiredError } from "../domain/wagering.errors";
import type { WagerPayload } from "./payload-hash";

export class InvalidPayloadError extends DomainError {
  readonly code = "INVALID_PAYLOAD";

  constructor(reason: string) {
    super(`payload inválido: ${reason}`);
  }
}

const REQUIRED_STRINGS = ["providerId", "externalTransactionId", "roundId", "gameId", "kind"] as const;
const SUBMITTABLE_KINDS = new Set<string>(
  Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening),
);

export function assertWagerPayload(body: unknown): asserts body is WagerPayload {
  const payload = body as Record<string, unknown> | null;
  if (typeof payload !== "object" || payload === null) throw new InvalidPayloadError("corpo ausente");

  for (const field of REQUIRED_STRINGS) {
    if (typeof payload[field] !== "string" || payload[field] === "") {
      throw new InvalidPayloadError(`campo ${field} é obrigatório`);
    }
  }
  if (!isUuid(payload.playerId)) throw new InvalidPayloadError("playerId precisa ser UUID");
  if (!isUuid(payload.walletId)) throw new InvalidPayloadError("walletId precisa ser UUID");

  const reference = payload.referenceExternalTransactionId;
  if (reference !== undefined && (typeof reference !== "string" || reference === "")) {
    throw new InvalidPayloadError("referenceExternalTransactionId precisa ser string");
  }

  if (!SUBMITTABLE_KINDS.has(payload.kind as string)) throw new KindNotAllowedError(payload.kind as string);
  if ((payload.kind === WagerTransactionKind.Refund || payload.kind === WagerTransactionKind.Rollback) && !reference) {
    throw new ReferenceRequiredError(payload.kind);
  }
  Money.from(payload.money as { amount: string; currency: string });
}
