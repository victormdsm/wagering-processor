import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Logger,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { isUuid } from "../../../shared/application/uuid";
import { ProviderAuthGuard } from "../../../shared/infrastructure/http/provider-auth.guard";
import { Metrics } from "../../../shared/infrastructure/observability/metrics";
import { TransactionRunner } from "../../../shared/infrastructure/persistence/transaction-runner";
import { hashWagerPayload, type WagerPayload } from "../../application/payload-hash";
import { assertWagerPayload } from "../../application/payload-validation";
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionOutput,
} from "../../application/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../domain/wager-transaction-status";
import { IdempotencyConflictError, WagerTransactionNotFoundError } from "../../domain/wagering.errors";
import { IdempotencyKeyRepository } from "../persistence/idempotency-key.repository";
import { WagerTransactionQueries } from "../persistence/wager-transaction.queries";

const STATUS_BY_RESULT: Record<WagerTransactionStatus, HttpStatus> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly idempotencyKeys: IdempotencyKeyRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly queries: WagerTransactionQueries,
    private readonly metrics: Metrics,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: WagerPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) throw new BadRequestException("header Idempotency-Key é obrigatório");
    assertWagerPayload(body);
    const payloadHash = hashWagerPayload(body);
    const stopTimer = this.metrics.processingDuration.startTimer({ entry: "http" });

    const { status, response, replay } = await this.runner.run(async () => {
      const existing = await this.idempotencyKeys.find(body.providerId, idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new IdempotencyConflictError(idempotencyKey);
        return {
          status: existing.responseCode!,
          response: { ...(existing.responseBody as unknown as ProcessWagerTransactionOutput), idempotentReplay: true },
          replay: true,
        };
      }

      const key = await this.idempotencyKeys.start(body.providerId, idempotencyKey, payloadHash);
      const output = await this.processWagerTransaction.execute({ ...body, idempotencyKey });
      const outputStatus = STATUS_BY_RESULT[output.status];
      this.idempotencyKeys.complete(key, outputStatus, { ...output });
      return { status: outputStatus, response: { ...output }, replay: output.idempotentReplay };
    });
    stopTimer();

    if (replay) this.metrics.duplicates.inc({ source: "idempotency_key" });
    this.metrics.transactions.inc({ status: response.status, entry: "http" });
    this.logger.log("transação processada", {
      correlationId: idempotencyKey,
      transactionId: response.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      status: response.status,
      idempotentReplay: replay,
    });

    res.status(status);
    return response;
  }

  @Get("wagering/transactions/:transactionId")
  findById(@Param("transactionId") transactionId: string) {
    if (!isUuid(transactionId)) throw new WagerTransactionNotFoundError(transactionId);
    return this.queries.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  findByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.queries.byExternalId(providerId, externalTransactionId);
  }
}
