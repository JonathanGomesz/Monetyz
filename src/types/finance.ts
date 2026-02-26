export type Account = "Main" | "Uni" | "Gear";
export type TxType = "income" | "expense" | "transfer";

export type TxBase = {
  id: string;
  amount: number;      // positive number always
  note?: string;       // optional
  date: string;        // YYYY-MM-DD
  createdAt: number;   // timestamp
  category?: string;   // optional (for income/expense)
};

export type IncomeTx = TxBase & {
  type: "income";
  account: Account; // where the money lands
};

export type ExpenseTx = TxBase & {
  type: "expense";
  account: Account; // where the money is spent from
};

export type TransferTx = TxBase & {
  type: "transfer";
  from: Account;
  to: Account;
};

export type Tx = IncomeTx | ExpenseTx | TransferTx;