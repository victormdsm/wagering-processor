import type { MoneyProps } from "../../src/shared/domain/money";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function request<T = any>(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export const brl = (amount: string): MoneyProps => ({ amount, currency: "BRL" });

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function createWallet(url: string, amount = "100.00", currency = "BRL"): Promise<TestWallet> {
  const playerId = crypto.randomUUID();
  const res = await request(url, "POST", "/wallets", { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`criação de wallet falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, playerId };
}

export interface WagerInput {
  kind: string;
  amount?: string;
  currency?: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
}

export function wagerPayload(wallet: TestWallet, input: WagerInput) {
  return {
    providerId: input.providerId ?? "provider-a",
    externalTransactionId: input.externalTransactionId ?? `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: input.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: input.kind,
    money: { amount: input.amount ?? "25.00", currency: input.currency ?? "BRL" },
    ...(input.referenceExternalTransactionId && { referenceExternalTransactionId: input.referenceExternalTransactionId }),
  };
}

export const keyOf = (payload: { providerId: string; externalTransactionId: string }) =>
  `${payload.providerId}:${payload.externalTransactionId}`;

export function submit(url: string, payload: ReturnType<typeof wagerPayload>, idempotencyKey = keyOf(payload)) {
  return request(url, "POST", "/wagering/transactions", payload, { "idempotency-key": idempotencyKey });
}

export async function wager(url: string, wallet: TestWallet, input: WagerInput) {
  const payload = wagerPayload(wallet, input);
  const res = await submit(url, payload);
  return { ...res, payload };
}
