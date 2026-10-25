import { defineEntity, p } from "@mikro-orm/core";

const WalletSchema = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balance: p.decimal().precision(19).scale(2),
    version: p.integer().version(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
  uniques: [{ properties: ["playerId", "currency"] }],
  checks: [{ name: "wallets_balance_non_negative", expression: "balance >= 0" }],
});

export class WalletRecord extends WalletSchema.class {}
WalletSchema.setClass(WalletRecord);
