import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import config from './shared/infrastructure/persistence/mikro-orm.config';
import { WageringModule } from './wagering/wagering.module';
import { WalletApiModule } from './wallet/wallet-api.module';

@Module({
  imports: [MikroOrmModule.forRoot(config), WageringModule, WalletApiModule],
})
export class AppModule {}
