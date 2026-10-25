import { beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import config from "../../src/shared/infrastructure/persistence/mikro-orm.config";
import { TEST_ENV } from "../support/env";
import { db, recreateDatabase, setupInfra } from "../support/infra";

setDefaultTimeout(60_000);

describe("migrations", () => {
  test("up → down → up em um banco vazio", async () => {
    const url = TEST_ENV.DATABASE_URL.replace(/\/[^/]+$/, "/wagering_migrations_test");
    await recreateDatabase(url);
    const orm = await MikroORM.init({ ...config, clientUrl: url });
    const sql = new SQL(url);
    const tables = async () =>
      (await sql`select tablename from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations' order by 1`).map(
        (r: { tablename: string }) => r.tablename,
      );
    try {
      await orm.migrator.up();
      expect(await tables()).toEqual([
        "idempotency_keys",
        "inbox_messages",
        "outbox_messages",
        "wager_transactions",
        "wallet_ledger_entries",
        "wallets",
      ]);
      await orm.migrator.down({ to: 0 });
      expect(await tables()).toEqual([]);
      await orm.migrator.up();
      expect((await tables()).length).toBe(6);
      expect(await orm.migrator.checkSchema()).toBe(false);
    } finally {
      await sql.close();
      await orm.close();
    }
  });
});

describe("constraints do schema", () => {
  beforeAll(setupInfra);

  async function violates(work: (tx: SQL) => Promise<unknown>): Promise<string> {
    try {
      await db().begin(async (tx) => {
        await work(tx);
        throw new Error("NO_VIOLATION");
      });
    } catch (error) {
      return String((error as Error).message);
    }
    return "NO_VIOLATION";
  }

  async function seed(tx: SQL, balance = "100.00") {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${walletId}, ${playerId}, 'BRL', ${balance}, 1, now(), now())`;
    await insertTransaction(tx, { id: transactionId, walletId, playerId, kind: "BET" });
    return { walletId, playerId, transactionId };
  }

  function insertTransaction(
    tx: SQL,
    t: { id: string; walletId: string; playerId: string; kind: string; reference?: string | null; referenceId?: string | null; external?: string },
  ) {
    const external = t.external ?? crypto.randomUUID();
    return tx`insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
       kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, created_at, attempts)
      values (${t.id}, 'p', ${external}, ${"k:" + external}, 'h', ${t.walletId}, ${t.playerId}, 'r', 'g',
              ${t.kind}, '25.00', 'BRL', ${t.reference ?? null}, ${t.referenceId ?? null}, 'PROCESSED', now(), 0)`;
  }

  function insertEntry(tx: SQL, walletId: string, transactionId: string, direction: string, amount: string, before: string, after: string) {
    return tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, currency, created_at)
              values (${crypto.randomUUID()}, ${walletId}, ${transactionId}, ${direction}, ${amount}, ${before}, ${after}, 'BRL', now())`;
  }

  test("sanidade: o seed sozinho não viola nada", async () => {
    expect(await violates((tx) => seed(tx))).toBe("NO_VIOLATION");
  });

  test("wallets: saldo não negativo", async () => {
    expect(await violates((tx) => seed(tx, "-0.01"))).toContain("wallets_balance_non_negative");
  });

  test("wallets: uma por playerId + currency", async () => {
    const message = await violates(async (tx) => {
      const { playerId } = await seed(tx);
      await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
               values (${crypto.randomUUID()}, ${playerId}, 'BRL', 0, 1, now(), now())`;
    });
    expect(message).toContain("wallets_player_id_currency_unique");
  });

  test("ledger: aritmética do lançamento", async () => {
    const message = await violates(async (tx) => {
      const { walletId, transactionId } = await seed(tx);
      await insertEntry(tx, walletId, transactionId, "DEBIT", "25.00", "100.00", "80.00");
    });
    expect(message).toContain("wallet_ledger_entries_balanced");
  });

  test("ledger: saldo após não negativo e valor positivo", async () => {
    expect(
      await violates(async (tx) => {
        const { walletId, transactionId } = await seed(tx);
        await insertEntry(tx, walletId, transactionId, "DEBIT", "25.00", "10.00", "-15.00");
      }),
    ).toContain("wallet_ledger_entries_balance_after_non_negative");
    expect(
      await violates(async (tx) => {
        const { walletId, transactionId } = await seed(tx);
        await insertEntry(tx, walletId, transactionId, "CREDIT", "0.00", "10.00", "10.00");
      }),
    ).toContain("wallet_ledger_entries_amount_positive");
  });

  test("ledger: no máximo um lançamento por transação e wallet", async () => {
    const message = await violates(async (tx) => {
      const { walletId, transactionId } = await seed(tx);
      await insertEntry(tx, walletId, transactionId, "DEBIT", "25.00", "100.00", "75.00");
      await insertEntry(tx, walletId, transactionId, "DEBIT", "25.00", "75.00", "50.00");
    });
    expect(message).toContain("wallet_ledger_entries_wallet_id_transaction_id_unique");
  });

  test("ledger: UPDATE e DELETE são recusados (imutável)", async () => {
    for (const statement of ["update wallet_ledger_entries set amount = amount", "delete from wallet_ledger_entries"]) {
      const message = await violates(async (tx) => {
        const { walletId, transactionId } = await seed(tx);
        await insertEntry(tx, walletId, transactionId, "DEBIT", "25.00", "100.00", "75.00");
        await tx.unsafe(`${statement} where wallet_id = '${walletId}'`);
      });
      expect(message).toContain("imutável");
    }
  });

  test("transações: (providerId, externalTransactionId) e idempotency key únicos", async () => {
    const message = await violates(async (tx) => {
      const { walletId, playerId } = await seed(tx);
      await insertTransaction(tx, { id: crypto.randomUUID(), walletId, playerId, kind: "BET", external: "dup" });
      await insertTransaction(tx, { id: crypto.randomUUID(), walletId, playerId, kind: "BET", external: "dup" });
    });
    expect(message).toContain("unique");
  });

  test("transações: REFUND e ROLLBACK exigem referência", async () => {
    const message = await violates(async (tx) => {
      const { walletId, playerId } = await seed(tx);
      await insertTransaction(tx, { id: crypto.randomUUID(), walletId, playerId, kind: "REFUND" });
    });
    expect(message).toContain("wager_transactions_reference_required");
  });

  test("transações: uma referência só é revertida uma vez (REFUND ou ROLLBACK)", async () => {
    for (const second of ["REFUND", "ROLLBACK"]) {
      const message = await violates(async (tx) => {
        const { walletId, playerId, transactionId } = await seed(tx);
        const reversal = { walletId, playerId, reference: "x", referenceId: transactionId };
        await insertTransaction(tx, { ...reversal, id: crypto.randomUUID(), kind: "REFUND" });
        await insertTransaction(tx, { ...reversal, id: crypto.randomUUID(), kind: second });
      });
      expect(message).toContain("wager_transactions_reversal_unique");
    }
  });

  test("transações: vários WIN/LOSS podem referenciar a mesma BET", async () => {
    const message = await violates(async (tx) => {
      const { walletId, playerId, transactionId } = await seed(tx);
      for (const kind of ["WIN", "WIN", "LOSS"]) {
        await insertTransaction(tx, { id: crypto.randomUUID(), walletId, playerId, kind, referenceId: transactionId });
      }
    });
    expect(message).toBe("NO_VIOLATION");
  });

  test("inbox: (consumerName, messageId) único", async () => {
    const message = await violates(async (tx) => {
      for (let i = 0; i < 2; i++) {
        await tx`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c', 'm', 'h', now())`;
      }
    });
    expect(message).toContain("inbox_messages_pkey");
  });
});
