// F17 account adapter stub. Real DSH account bridge arrives in M4.

export interface Balance {
  balance: number;
  gift_balance: number;
}

export interface UsageRecord {
  date: string;
  cost: number;
  requests: number;
  tokens: number;
}

export type BalanceChangeHandler = (balance: Balance) => void;

const NOT_IMPLEMENTED = "Not implemented (F17 stub)";

function notImplemented(method: string): never {
  console.warn(`[account-adapter] ${method}: ${NOT_IMPLEMENTED}`);
  throw new Error(NOT_IMPLEMENTED);
}

export const AccountService = {
  getBalance(): Balance {
    return notImplemented("getBalance");
  },
  getUsage(_days: number): UsageRecord[] {
    return notImplemented("getUsage");
  },
  openTopUpView(): void {
    notImplemented("openTopUpView");
  },
  onBalanceChange(_handler: BalanceChangeHandler): () => void {
    return notImplemented("onBalanceChange");
  },
};
