import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { WageringModule } from "../wagering/wagering.module";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import { WalletsController } from "./infrastructure/http/wallets.controller";
import { WalletQueries } from "./infrastructure/persistence/wallet.queries";
import { WalletModule } from "./wallet.module";

@Module({
  imports: [SharedModule, WalletModule, WageringModule],
  controllers: [WalletsController],
  providers: [CreateWalletUseCase, ReconcileWalletUseCase, WalletQueries],
})
export class WalletApiModule {}
