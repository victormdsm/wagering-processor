import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { isUuid } from "../../../shared/application/uuid";
import { ProviderAuthGuard } from "../../../shared/infrastructure/http/provider-auth.guard";
import { Metrics } from "../../../shared/infrastructure/observability/metrics";
import { TransactionRunner } from "../../../shared/infrastructure/persistence/transaction-runner";
import { CreateWalletUseCase, type CreateWalletInput } from "../../application/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
import { WalletNotFoundError } from "../../domain/wallet.errors";
import { InvalidCursorError, WalletQueries } from "../persistence/wallet.queries";

const DEFAULT_LEDGER_LIMIT = 50;

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly createWallet: CreateWalletUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly queries: WalletQueries,
    private readonly metrics: Metrics,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletInput) {
    if (!isUuid(body?.playerId)) {
      throw new BadRequestException("campo playerId é obrigatório e precisa ser UUID");
    }
    if (typeof body.initialBalance !== "object" || body.initialBalance === null) {
      throw new BadRequestException("campo initialBalance é obrigatório");
    }

    const wallet = await this.runner.run(() => this.createWallet.execute(body));
    this.logger.log("wallet criada", { walletId: wallet.id });
    return wallet;
  }

  @Get(":walletId")
  findOne(@Param("walletId") walletId: string) {
    assertWalletId(walletId);
    return this.queries.byId(walletId);
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    assertWalletId(walletId);
    try {
      return await this.queries.ledger(walletId, cursor, limit ? Number(limit) || DEFAULT_LEDGER_LIMIT : DEFAULT_LEDGER_LIMIT);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw new BadRequestException("cursor inválido");
      throw error;
    }
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    assertWalletId(walletId);
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      this.metrics.reconciliationDivergences.inc();
      this.logger.warn("saldo divergente do ledger", {
        walletId,
        difference: result.difference.amount,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}

function assertWalletId(walletId: string): void {
  if (!isUuid(walletId)) throw new WalletNotFoundError(walletId);
}
