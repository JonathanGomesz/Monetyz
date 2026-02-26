import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Account, Tx, TxType } from "./types/finance";
import { supabase } from "./lib/supabase";
import { addTx, deleteTx, loadTxs } from "./lib/storage";
import "./index.css";
import logo from "./logo.svg";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatLKR(n: number) {
  return `LKR ${Math.round(n).toLocaleString("en-LK")}`;
}

type AccountFilter = "All" | Account;

type DbTxRow = {
  id: string;
  user_id: string;
  type: "income" | "expense" | "transfer";
  account: string | null;
  from_account: string | null;
  to_account: string | null;
  category: string | null;
  amount: number;
  note: string | null;
  date: string; // YYYY-MM-DD
  created_at: string; // timestamptz
};

function rowToTx(r: DbTxRow): Tx {
  const createdAt = Date.parse(r.created_at);

  if (r.type === "transfer") {
    return {
      id: r.id,
      type: "transfer",
      from: (r.from_account ?? "Main") as Account,
      to: (r.to_account ?? "Uni") as Account,
      amount: Number(r.amount),
      note: r.note ?? undefined,
      date: r.date,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    };
  }

  return {
    id: r.id,
    type: r.type,
    account: (r.account ?? "Main") as Account,
    category: (r.category ?? "Uncategorized") as string,
    amount: Number(r.amount),
    note: r.note ?? undefined,
    date: r.date,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

async function loadCloudTxs(): Promise<Tx[]> {
  const { data, error } = await supabase
    .from("txs")
    .select(
      "id,user_id,type,account,from_account,to_account,category,amount,note,date,created_at"
    )
    .order("created_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as DbTxRow[]).map(rowToTx);
}

// --- One-time local -> cloud migration helpers ---
function migrateFlagKey(userId: string) {
  return `txs_migrated_${userId}`;
}

async function migrateLocalToCloudOnce(userId: string): Promise<boolean> {
  // returns true if a migration happened
  const key = migrateFlagKey(userId);
  if (localStorage.getItem(key) === "1") return false;

  const local = loadTxs();
  if (local.length === 0) {
    localStorage.setItem(key, "1");
    return false;
  }

  // If cloud already has rows, we don't auto-merge.
  const cloudExisting = await loadCloudTxs();
  if (cloudExisting.length > 0) {
    localStorage.setItem(key, "1");
    return false;
  }

  const rows: Array<Omit<DbTxRow, "user_id" | "created_at">> = local.map((tx) => {
    if (tx.type === "transfer") {
      return {
        id: tx.id,
        type: "transfer",
        account: null,
        from_account: tx.from,
        to_account: tx.to,
        category: null,
        amount: tx.amount,
        note: tx.note ?? null,
        date: tx.date,
      };
    }

    // income/expense
    return {
      id: tx.id,
      type: tx.type,
      account: tx.account ?? null,
      from_account: null,
      to_account: null,
      category: (tx.category ?? null),
      amount: tx.amount,
      note: tx.note ?? null,
      date: tx.date,
    };
  });

  const { error } = await supabase.from("txs").upsert(rows, { onConflict: "id" });
  if (error) throw error;

  localStorage.setItem(key, "1");
  return true;
}

export default function App() {
  const [txs, setTxs] = useState<Tx[]>([]);
  const [open, setOpen] = useState(false);

  // auth/cloud
  const [session, setSession] = useState<Session | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  const [month, setMonth] = useState<string>(todayISO().slice(0, 7)); // YYYY-MM
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("All");

  // form state
  const [type, setType] = useState<TxType>("expense");

  // income/expense
  const [account, setAccount] = useState<Account>("Main");

  // transfer
  const [from, setFrom] = useState<Account>("Main");
  const [to, setTo] = useState<Account>("Uni");

  const [category, setCategory] = useState<string>("Uncategorized");
  const [amount, setAmount] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());

  // session watcher
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  // load txs: cloud if signed in, else local
  useEffect(() => {
    (async () => {
      try {
        if (session) {
          setCloudBusy(true);

          // One-time: if user had local data and cloud is empty, push local up.
          try {
            const didMigrate = await migrateLocalToCloudOnce(session.user.id);
            if (didMigrate) console.log("Migrated local transactions to cloud.");
          } catch (e) {
            console.error(e);
            // don’t block app if migration fails
          }

          const cloud = await loadCloudTxs();
          setTxs(cloud);
          setCloudBusy(false);
        } else {
          setTxs(loadTxs());
        }
      } catch (e) {
        console.error(e);
        alert("Cloud sync load failed. Using local data for now.");
        setTxs(loadTxs());
        setCloudBusy(false);
      }
    })();
  }, [session]);

  const monthTxs = useMemo(() => {
    return txs.filter((t) => {
      if (!t.date.startsWith(month)) return false;

      if (accountFilter === "All") return true;

      if (t.type === "transfer") return t.from === accountFilter || t.to === accountFilter;

      return t.account === accountFilter;
    });
  }, [txs, month, accountFilter]);

  const monthAllTxs = useMemo(() => {
    return txs.filter((t) => t.date.startsWith(month));
  }, [txs, month]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;

    let mainNet = 0;
    let uniNet = 0;
    let gearNet = 0;

    for (const t of monthTxs) {
      if (t.type === "income") {
        income += t.amount;

        if (t.account === "Main") mainNet += t.amount;
        if (t.account === "Uni") uniNet += t.amount;
        if (t.account === "Gear") gearNet += t.amount;
      }

      if (t.type === "expense") {
        expense += t.amount;

        if (t.account === "Main") mainNet -= t.amount;
        if (t.account === "Uni") uniNet -= t.amount;
        if (t.account === "Gear") gearNet -= t.amount;
      }

      if (t.type === "transfer") {
        // does NOT affect income/expense totals
        if (t.from === "Main") mainNet -= t.amount;
        if (t.from === "Uni") uniNet -= t.amount;
        if (t.from === "Gear") gearNet -= t.amount;

        if (t.to === "Main") mainNet += t.amount;
        if (t.to === "Uni") uniNet += t.amount;
        if (t.to === "Gear") gearNet += t.amount;
      }
    }

    const netFlow = income - expense; // accounting style
    const available = mainNet; // what’s actually left in Main after transfers
    const savings = uniNet + gearNet;

    return { available, netFlow, income, expense, savings, mainNet, uniNet, gearNet };
  }, [monthTxs]);

  const balances = useMemo(() => {
    let main = 0;
    let uni = 0;
    let gear = 0;

    for (const t of monthAllTxs) {
      if (t.type === "income") {
        if (t.account === "Main") main += t.amount;
        if (t.account === "Uni") uni += t.amount;
        if (t.account === "Gear") gear += t.amount;
      }

      if (t.type === "expense") {
        if (t.account === "Main") main -= t.amount;
        if (t.account === "Uni") uni -= t.amount;
        if (t.account === "Gear") gear -= t.amount;
      }

      if (t.type === "transfer") {
        if (t.from === "Main") main -= t.amount;
        if (t.from === "Uni") uni -= t.amount;
        if (t.from === "Gear") gear -= t.amount;

        if (t.to === "Main") main += t.amount;
        if (t.to === "Uni") uni += t.amount;
        if (t.to === "Gear") gear += t.amount;
      }
    }

    return { main, uni, gear };
  }, [monthAllTxs]);

  async function signIn() {
    setAuthBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthBusy(false);
    if (error) return alert(error.message);
    setAuthOpen(false);
    setEmail("");
    setPassword("");
  }

  async function signUp() {
    setAuthBusy(true);
    const { error } = await supabase.auth.signUp({ email, password });
    setAuthBusy(false);
    if (error) return alert(error.message);
    alert("Signup created ✅ Check your email to confirm, then sign in.");
    setAuthMode("signin");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  function resetForm() {
    setType("expense");
    setAccount("Main");
    setFrom("Main");
    setTo("Uni");
    setCategory("Uncategorized");
    setAmount("");
    setNote("");
    setDate(todayISO());
  }

  async function onAdd() {
    const clean = Number(String(amount).replaceAll(",", "").trim());
    if (!clean || clean <= 0) return alert("Enter a valid amount");

    let tx: Tx;

    if (type === "transfer") {
      if (from === to) return alert("Transfer: From and To can’t be the same");

      tx = {
        id: crypto.randomUUID(),
        type: "transfer",
        from,
        to,
        amount: clean,
        note: note.trim() || undefined,
        date,
        createdAt: Date.now(),
      };
    } else {
      tx = {
        id: crypto.randomUUID(),
        type, // income | expense
        account,
        category: category.trim() || "Uncategorized",
        amount: clean,
        note: note.trim() || undefined,
        date,
        createdAt: Date.now(),
      };
    }

    if (session) {
      try {
        setCloudBusy(true);

        const payload: Omit<DbTxRow, "user_id" | "created_at"> = {
          id: tx.id,
          type: tx.type,

          account:
            tx.type === "transfer"
              ? null
              : ((tx as Extract<Tx, { type: "income" | "expense" }>).account ?? null),

          from_account:
            tx.type === "transfer"
              ? (tx as Extract<Tx, { type: "transfer" }>).from
              : null,

          to_account:
            tx.type === "transfer"
              ? (tx as Extract<Tx, { type: "transfer" }>).to
              : null,

          category:
            tx.type === "transfer"
              ? null
              : ((tx as Extract<Tx, { type: "income" | "expense" }>).category ?? null),

          amount: tx.amount,
          note: tx.note ?? null,
          date: tx.date,
        };

        const { error } = await supabase.from("txs").insert(payload);
        if (error) throw error;

        const cloud = await loadCloudTxs();
        setTxs(cloud);
        setCloudBusy(false);
      } catch (e) {
        console.error(e);
        alert("Cloud save failed. Saving locally instead.");
        addTx(tx);
        setTxs(loadTxs());
        setCloudBusy(false);
      }
    } else {
      addTx(tx);
      setTxs(loadTxs());
    }

    setOpen(false);
    resetForm();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this transaction?")) return;

    if (session) {
      try {
        setCloudBusy(true);
        const { error } = await supabase.from("txs").delete().eq("id", id);
        if (error) throw error;

        const cloud = await loadCloudTxs();
        setTxs(cloud);
        setCloudBusy(false);
      } catch (e) {
        console.error(e);
        alert("Cloud delete failed.");
        setCloudBusy(false);
      }
      return;
    }

    deleteTx(id);
    setTxs(loadTxs());
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-8 md:p-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <div className="flex items-center">
              <img
                src={logo}
                alt="Monetyz"
                className="h-[50px] w-[200px] object-contain drop-shadow-[0_0_18px_rgba(163,230,53,0.22)]"
                loading="eager"
                draggable={false}
              />
            </div>
            <p className="mt-3 text-zinc-400">Income • Expenses • Savings</p>
            <p className="mt-2 text-sm text-zinc-500">
              Cloud: {session ? "Connected ✅" : "Not signed in"}
              {cloudBusy ? <span className="ml-2">(syncing…)</span> : null}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {session ? (
              <>
                <span className="hidden sm:inline text-sm text-zinc-500">
                  {session.user.email}
                </span>
                <button
                  onClick={signOut}
                  className="rounded-full border border-zinc-800 px-4 py-2 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => setAuthOpen(true)}
                className="rounded-full border border-zinc-800 px-4 py-2 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
              >
                Sign in
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="text-sm text-zinc-400">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-2 text-zinc-200 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
          />
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value as AccountFilter)}
            className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-2 text-zinc-200 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
          >
            <option value="All">All Accounts</option>
            <option value="Main">Main</option>
            <option value="Uni">Uni</option>
            <option value="Gear">Gear</option>
          </select>
          <span className="text-sm text-zinc-500">Showing totals for {month}</span>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <Card label="Available (Main)" value={formatLKR(totals.available)} />
          <Card label="Income" value={formatLKR(totals.income)} />
          <Card label="Expenses" value={formatLKR(totals.expense)} />
          <div className="rounded-2xl bg-zinc-900/40 p-6 border border-zinc-800 transition duration-200 ease-out hover:bg-zinc-900/60 hover:border-zinc-700 hover:-translate-y-0.5">
            <p className="text-sm text-zinc-400">Savings (Uni + Gear)</p>
            <p className="text-3xl font-semibold mt-2">{formatLKR(totals.savings)}</p>
            <p className="text-sm text-zinc-500 mt-3">
              Uni: {formatLKR(totals.uniNet)} • Gear: {formatLKR(totals.gearNet)}
            </p>
          </div>
        </div>

        {/* Account balance strip (quick filter) */}
        <div className="mt-4 flex flex-wrap gap-3">
          <FilterPill
            label="All"
            value={formatLKR(balances.main + balances.uni + balances.gear)}
            active={accountFilter === "All"}
            onClick={() => setAccountFilter("All")}
          />
          <FilterPill
            label="Main"
            value={formatLKR(balances.main)}
            active={accountFilter === "Main"}
            onClick={() => setAccountFilter("Main")}
          />
          <FilterPill
            label="Uni"
            value={formatLKR(balances.uni)}
            active={accountFilter === "Uni"}
            onClick={() => setAccountFilter("Uni")}
          />
          <FilterPill
            label="Gear"
            value={formatLKR(balances.gear)}
            active={accountFilter === "Gear"}
            onClick={() => setAccountFilter("Gear")}
          />
        </div>

        <p className="mt-3 text-sm text-zinc-500">
          Net flow (Income − Expenses): {formatLKR(totals.netFlow)}
          <span className="mx-2">•</span>
          Available shows what’s left in <span className="text-zinc-300">Main</span> after transfers.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setOpen(true)}
            className="rounded-full bg-lime-400 text-black px-6 py-3 font-semibold transition hover:opacity-95 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.18)] active:scale-[0.99]"
          >
            + Add Transaction
          </button>
        </div>

        <div className="mt-10">
          <h2 className="text-xl font-semibold">Recent</h2>

          <div className="mt-4 space-y-3">
            {monthTxs.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 text-zinc-300">
                No transactions for this month yet. Add one 👇
              </div>
            ) : (
              monthTxs.slice(0, 10).map((t) => (
                <div
                  key={t.id}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={[
                          "text-sm px-2 py-1 rounded-full border",
                          t.type === "income" &&
                            "border-emerald-700/60 bg-emerald-500/10 text-emerald-200",
                          t.type === "expense" &&
                            "border-rose-700/60 bg-rose-500/10 text-rose-200",
                          t.type === "transfer" &&
                            "border-sky-700/60 bg-sky-500/10 text-sky-200",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {t.type}
                      </span>

                      <span className="text-zinc-400 text-sm">{t.date}</span>

                      {t.type === "transfer" ? (
                        <span className="text-zinc-400 text-sm">
                          • {t.from} → {t.to}
                        </span>
                      ) : (
                        <>
                          <span className="text-zinc-400 text-sm">• {t.account}</span>
                          {t.category ? (
                            <span className="text-zinc-400 text-sm">• {t.category}</span>
                          ) : null}
                        </>
                      )}
                    </div>

                    <div className="mt-2 text-lg font-semibold">{formatLKR(t.amount)}</div>

                    {t.note ? (
                      <div className="text-zinc-400 text-sm mt-1">{t.note}</div>
                    ) : null}
                  </div>

                  <button
                    onClick={() => onDelete(t.id)}
                    className="rounded-xl border border-zinc-700 px-4 py-2 text-zinc-200 transition hover:bg-zinc-800 hover:border-zinc-600 active:scale-[0.99]"
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Add Transaction Modal */}
      {open ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto animate-fadeIn">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl bg-zinc-950/80 border border-zinc-800 p-6 shadow-2xl animate-popIn">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Add Transaction</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-zinc-400 transition hover:text-white hover:scale-105"
              >
                ✕
              </button>
            </div>

            <div className="mt-5 space-y-4 min-h-0">
              <div>
                <label className="text-sm text-zinc-400">Type</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as TxType)}
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                >
                  <option value="income">income</option>
                  <option value="expense">expense</option>
                  <option value="transfer">transfer</option>
                </select>
              </div>

              {type === "transfer" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-zinc-400">From</label>
                    <select
                      value={from}
                      onChange={(e) => setFrom(e.target.value as Account)}
                      className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                    >
                      <option value="Main">Main</option>
                      <option value="Uni">Uni</option>
                      <option value="Gear">Gear</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400">To</label>
                    <select
                      value={to}
                      onChange={(e) => setTo(e.target.value as Account)}
                      className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                    >
                      <option value="Main">Main</option>
                      <option value="Uni">Uni</option>
                      <option value="Gear">Gear</option>
                    </select>
                  </div>

                  <p className="col-span-2 text-xs text-zinc-500 mt-1">
                    Transfer moves money between accounts. It won’t change Income/Expenses totals.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="text-sm text-zinc-400">Account</label>
                  <select
                    value={account}
                    onChange={(e) => setAccount(e.target.value as Account)}
                    className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                  >
                    <option value="Main">Main</option>
                    <option value="Uni">Uni</option>
                    <option value="Gear">Gear</option>
                  </select>
                  <p className="text-xs text-zinc-500 mt-2">
                    Income/Expense affects totals. Use Uni/Gear to track savings buckets.
                  </p>
                </div>
              )}

              {type === "transfer" ? null : (
                <div>
                  <label className="text-sm text-zinc-400">Category</label>
                  <input
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Food, Fuel, Bills, Shoot"
                    className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                  />
                </div>
              )}

              <div>
                <label className="text-sm text-zinc-400">Amount (LKR)</label>
                <input
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 2500"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>

              <div>
                <label className="text-sm text-zinc-400">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>

              <div>
                <label className="text-sm text-zinc-400">Note (optional)</label>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Dialog bill"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={onAdd}
                  className="flex-1 rounded-full bg-lime-400 text-black px-6 py-3 font-semibold transition hover:opacity-95 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.18)] active:scale-[0.99]"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setOpen(false);
                    resetForm();
                  }}
                  className="flex-1 rounded-full border border-zinc-800 px-6 py-3 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700 active:scale-[0.99]"
                >
                  Cancel
                </button>
              </div>

              <p className="text-xs text-zinc-500">
                MVP note: Available (Main) changes with transfers. Net flow = Income − Expenses. Uni/Gear totals track your savings buckets.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Auth Modal */}
      {authOpen ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto animate-fadeIn">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl bg-zinc-950/80 border border-zinc-800 p-6 shadow-2xl animate-popIn">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">
                {authMode === "signin" ? "Sign in" : "Create account"}
              </h3>
              <button
                onClick={() => setAuthOpen(false)}
                className="text-zinc-400 transition hover:text-white hover:scale-105"
              >
                ✕
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="text-sm text-zinc-400">Email</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  placeholder="you@example.com"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>

              <div>
                <label className="text-sm text-zinc-400">Password</label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="••••••••"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
                <p className="text-xs text-zinc-500 mt-2">Use 8+ chars.</p>
              </div>

              <div className="flex gap-3 pt-2">
                {authMode === "signin" ? (
                  <button
                    disabled={authBusy}
                    onClick={signIn}
                    className="flex-1 rounded-full bg-lime-400 text-black px-6 py-3 font-semibold transition hover:opacity-95 active:scale-[0.99] disabled:opacity-60"
                  >
                    {authBusy ? "Signing in…" : "Sign in"}
                  </button>
                ) : (
                  <button
                    disabled={authBusy}
                    onClick={signUp}
                    className="flex-1 rounded-full bg-lime-400 text-black px-6 py-3 font-semibold transition hover:opacity-95 active:scale-[0.99] disabled:opacity-60"
                  >
                    {authBusy ? "Creating…" : "Sign up"}
                  </button>
                )}

                <button
                  onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}
                  className="flex-1 rounded-full border border-zinc-800 px-6 py-3 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700 active:scale-[0.99]"
                >
                  {authMode === "signin" ? "Create account" : "Have an account"}
                </button>
              </div>

              <p className="text-xs text-zinc-500">
                Cloud data is private per account (RLS). Sign in on another device to see your own transactions.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-zinc-900/40 p-6 border border-zinc-800 transition duration-200 ease-out hover:bg-zinc-900/60 hover:border-zinc-700 hover:-translate-y-0.5">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className="text-3xl font-semibold mt-2">{value}</p>
    </div>
  );
}

function FilterPill({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-2xl border px-4 py-3 text-left transition active:scale-[0.99] " +
        (active
          ? "border-lime-400/40 bg-lime-400/10 shadow-[0_0_0_6px_rgba(163,230,53,0.08)]"
          : "border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900 hover:border-zinc-700")
      }
      aria-pressed={active}
    >
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </button>
  );
}