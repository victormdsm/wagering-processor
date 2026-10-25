import { expect } from "bun:test";
import { db } from "./infra";

export async function expectLedgerConsistent(): Promise<void> {
  const divergent = await db()`
    select w.id, w.balance,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as calculated
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id
     group by w.id, w.balance
    having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)`;
  expect(divergent).toEqual([]);
  const [{ negative }] = await db()`select count(*)::int as negative from wallets where balance < 0`;
  expect(negative).toBe(0);
}

export async function walletState(walletId: string) {
  const [wallet] = await db()`select balance::text as balance, version from wallets where id = ${walletId}`;
  const entries = await db()`
    select direction, amount::text as amount from wallet_ledger_entries where wallet_id = ${walletId} order by created_at, id`;
  return { balance: wallet.balance as string, version: wallet.version as number, entries };
}

export async function transactionByExternalId(providerId: string, externalTransactionId: string) {
  const [row] = await db()`
    select id, status, failure_code, attempts from wager_transactions
     where provider_id = ${providerId} and external_transaction_id = ${externalTransactionId}`;
  return row as { id: string; status: string; failure_code: string | null; attempts: number } | undefined;
}
