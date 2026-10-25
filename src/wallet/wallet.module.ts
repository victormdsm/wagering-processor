import { Module } from "@nestjs/common";
import { WalletLedgerRepository, WalletRepository } from "./domain/wallet.repository";
import {
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from "./infrastructure/persistence/mikro-orm-wallet.repository";

@Module({
  providers: [
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: WalletLedgerRepository, useClass: MikroOrmWalletLedgerRepository },
  ],
  exports: [WalletRepository, WalletLedgerRepository],
})
export class WalletModule {}
