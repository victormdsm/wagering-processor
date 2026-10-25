import type { WagerTransaction } from "./wager-transaction";

export abstract class WagerTransactionRepository {
  abstract findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  abstract isAlreadyReversed(referenceTransactionId: string): Promise<boolean>;
  abstract lockDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  abstract save(transaction: WagerTransaction): Promise<void>;
}
