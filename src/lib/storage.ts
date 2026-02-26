import type { Tx } from "../types/finance";

const KEY = "jft:txs:v1";

export function loadTxs(): Tx[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Tx[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveTxs(txs: Tx[]) {
  localStorage.setItem(KEY, JSON.stringify(txs));
}

export function addTx(tx: Tx) {
  const txs = loadTxs();
  txs.unshift(tx); // newest first
  saveTxs(txs);
}

export function deleteTx(id: string) {
  const txs = loadTxs().filter((t) => t.id !== id);
  saveTxs(txs);
}