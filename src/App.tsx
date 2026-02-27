import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Account, Tx, TxType } from "./types/finance";
import { supabase } from "./lib/supabase";
import { addTx, deleteTx, loadTxs } from "./lib/storage";
import "./index.css";
import logo from "./logo.svg";
import leftHero from "./assets/left-hero.png";

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

type AccountRow = {
  id?: string;
  name: string;
  created_at?: string;
  sort_order?: number | null;
  is_primary?: boolean | null;
};

// ---------- Rules (Auto-categorize) ----------
type CategoryRule = {
  id: string;
  keyword: string;
  category: string;
};

const RULES_KEY = "monetyz_category_rules_v1";

function loadRules(): CategoryRule[] {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => ({
        id: String(r.id ?? crypto.randomUUID()),
        keyword: String(r.keyword ?? "").trim(),
        category: String(r.category ?? "").trim(),
      }))
      .filter((r) => r.keyword && r.category);
  } catch {
    return [];
  }
}

function saveRules(rules: CategoryRule[]) {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

function applyRules(note: string, rules: CategoryRule[]): string | null {
  const text = (note ?? "").toLowerCase();
  if (!text) return null;
  for (const r of rules) {
    if (text.includes(r.keyword.toLowerCase())) return r.category;
  }
  return null;
}

// ---------- Tx mapping ----------
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
    .select("id,user_id,type,account,from_account,to_account,category,amount,note,date,created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as DbTxRow[]).map(rowToTx);
}

function migrateFlagKey(userId: string) {
  return `txs_migrated_${userId}`;
}

async function migrateLocalToCloudOnce(userId: string): Promise<boolean> {
  const key = migrateFlagKey(userId);
  if (localStorage.getItem(key) === "1") return false;

  const local = loadTxs();
  if (local.length === 0) {
    localStorage.setItem(key, "1");
    return false;
  }

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

    return {
      id: tx.id,
      type: tx.type,
      account: tx.account ?? null,
      from_account: null,
      to_account: null,
      category: tx.category ?? null,
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

const DEFAULT_ACCOUNTS: Account[] = ["Main", "Uni", "Gear"];

export default function App() {
  const [txs, setTxs] = useState<Tx[]>([]);
  const [open, setOpen] = useState(false);

  // Keep document dark (prevents iOS/Safari overscroll white gaps)
  useEffect(() => {
    const bg = "#09090b"; // zinc-950
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
    document.body.style.margin = "0";
    (document.documentElement.style as any).overscrollBehaviorY = "none";
    (document.body.style as any).overscrollBehaviorY = "none";

    return () => {
      document.documentElement.style.backgroundColor = "";
      document.body.style.backgroundColor = "";
      document.body.style.margin = "";
      (document.documentElement.style as any).overscrollBehaviorY = "";
      (document.body.style as any).overscrollBehaviorY = "";
    };
  }, []);

  // auth/cloud
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  // Accounts (synced via Supabase)
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>(DEFAULT_ACCOUNTS);
  const [primaryAccount, setPrimaryAccount] = useState<Account>(DEFAULT_ACCOUNTS[0]);

  const [acctOpen, setAcctOpen] = useState(false);
  const [newAcct, setNewAcct] = useState("");
  const [accountsBusy, setAccountsBusy] = useState(false);

  // Expense breakdown modal
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // Rules modal
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<CategoryRule[]>(() => loadRules());
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleCategory, setRuleCategory] = useState("");

  useEffect(() => {
    saveRules(rules);
  }, [rules]);

  // -------- Accounts helpers --------
  function sortAccountRows(rows: AccountRow[]) {
    // Prefer sort_order, fallback to created_at
    return [...rows].sort((a, b) => {
      const ao = a.sort_order ?? Number.POSITIVE_INFINITY;
      const bo = b.sort_order ?? Number.POSITIVE_INFINITY;

      if (ao !== bo) return ao - bo;

      const ad = a.created_at ? Date.parse(a.created_at) : 0;
      const bd = b.created_at ? Date.parse(b.created_at) : 0;
      return ad - bd;
    });
  }

  async function refreshAccounts() {
    if (!session) {
      setAccountRows([]);
      setAccounts(DEFAULT_ACCOUNTS);
      setPrimaryAccount(DEFAULT_ACCOUNTS[0]);
      return;
    }

    setAccountsBusy(true);
    try {
      // Try with extended columns (sort_order, is_primary)
      let data: any[] | null = null;

      const q1 = await supabase
        .from("accounts")
        .select("id,name,created_at,sort_order,is_primary")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (!q1.error) data = q1.data ?? null;

      // Fallback if table doesn't have those columns
      if (!data) {
        const q2 = await supabase
          .from("accounts")
          .select("id,name,created_at")
          .order("created_at", { ascending: true });
        if (q2.error) throw q2.error;
        data = q2.data ?? null;
      }

      const rows = (data ?? [])
        .map((r: any) => ({
          id: r.id ? String(r.id) : undefined,
          name: String(r.name ?? "").trim(),
          created_at: r.created_at ? String(r.created_at) : undefined,
          sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
          is_primary: typeof r.is_primary === "boolean" ? r.is_primary : null,
        }))
        .filter((r) => r.name) as AccountRow[];

      // Seed if empty
      if (rows.length === 0) {
        const seedPayload = DEFAULT_ACCOUNTS.map((name, idx) => ({
          name,
          sort_order: idx,
          is_primary: idx === 0,
        }));

        const { error: seedErr } = await supabase.from("accounts").insert(seedPayload);
        if (seedErr) throw seedErr;

        // Reload after seed
        const { data: seeded, error: seededErr } = await supabase
          .from("accounts")
          .select("id,name,created_at,sort_order,is_primary")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });

        if (seededErr) throw seededErr;

        const seededRows = (seeded ?? [])
          .map((r: any) => ({
            id: r.id ? String(r.id) : undefined,
            name: String(r.name ?? "").trim(),
            created_at: r.created_at ? String(r.created_at) : undefined,
            sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
            is_primary: typeof r.is_primary === "boolean" ? r.is_primary : null,
          }))
          .filter((r) => r.name) as AccountRow[];

        const ordered = sortAccountRows(seededRows);
        setAccountRows(ordered);
        const names = ordered.map((x) => x.name) as Account[];
        setAccounts(names.length ? names : DEFAULT_ACCOUNTS);

        const prim = ordered.find((x) => x.is_primary)?.name ?? names[0] ?? DEFAULT_ACCOUNTS[0];
        setPrimaryAccount(prim as Account);
      } else {
        const ordered = sortAccountRows(rows);
        setAccountRows(ordered);

        const names = ordered.map((x) => x.name) as Account[];
        setAccounts(names.length ? names : DEFAULT_ACCOUNTS);

        const prim = ordered.find((x) => x.is_primary)?.name ?? names[0] ?? DEFAULT_ACCOUNTS[0];
        setPrimaryAccount(prim as Account);
      }
    } catch (e) {
      console.error(e);
      setAccountRows([]);
      setAccounts(DEFAULT_ACCOUNTS);
      setPrimaryAccount(DEFAULT_ACCOUNTS[0]);
    } finally {
      setAccountsBusy(false);
    }
  }

  async function setPrimary(name: Account) {
    if (!session) return;
    setAccountsBusy(true);
    try {
      // Prefer is_primary updates
      const { error: clearErr } = await supabase.from("accounts").update({ is_primary: false }).neq("name", "");
      if (clearErr) throw clearErr;

      const { error: setErr } = await supabase.from("accounts").update({ is_primary: true }).eq("name", name);
      if (setErr) throw setErr;

      await refreshAccounts();
    } catch (e) {
      console.error(e);
      alert("Failed to set primary. (Do you have is_primary column?)");
    } finally {
      setAccountsBusy(false);
    }
  }

  async function moveAccount(name: Account, dir: -1 | 1) {
    if (!session) return;

    const idx = accountRows.findIndex((r) => r.name === name);
    if (idx === -1) return;

    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= accountRows.length) return;

    // Swap sort_order (fallback to index-based if null)
    const a = accountRows[idx];
    const b = accountRows[nextIdx];

    const aOrder = a.sort_order ?? idx;
    const bOrder = b.sort_order ?? nextIdx;

    setAccountsBusy(true);
    try {
      const { error } = await supabase.from("accounts").upsert(
        [
          { name: a.name, sort_order: bOrder },
          { name: b.name, sort_order: aOrder },
        ],
        { onConflict: "name" }
      );
      if (error) throw error;

      await refreshAccounts();
    } catch (e) {
      console.error(e);
      alert("Failed to reorder accounts. (Do you have sort_order column?)");
    } finally {
      setAccountsBusy(false);
    }
  }

  // -------- Dashboard state --------
  const [month, setMonth] = useState<string>(todayISO().slice(0, 7)); // YYYY-MM
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("All");

  // form state
  const [type, setType] = useState<TxType>("expense");
  const [account, setAccount] = useState<Account>("Main");
  const [from, setFrom] = useState<Account>("Main");
  const [to, setTo] = useState<Account>("Uni");

  const [category, setCategory] = useState<string>("Uncategorized");
  const [amount, setAmount] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [date, setDate] = useState<string>(todayISO());

  // keep selected accounts valid when list changes
  useEffect(() => {
    if (accounts.length === 0) return;
    const primary = accounts[0];
    const secondary = accounts[1] ?? accounts[0];

    if (!accounts.includes(account)) setAccount(primary);
    if (!accounts.includes(from)) setFrom(primary);
    if (!accounts.includes(to)) setTo(secondary);

    if (accountFilter !== "All" && !accounts.includes(accountFilter)) setAccountFilter("All");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

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

  // load accounts when session changes
  useEffect(() => {
    refreshAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  // load txs: cloud if signed in, else local
  useEffect(() => {
    (async () => {
      try {
        if (session) {
          setCloudBusy(true);

          try {
            const didMigrate = await migrateLocalToCloudOnce(session.user.id);
            if (didMigrate) console.log("Migrated local transactions to cloud.");
          } catch (e) {
            console.error(e);
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

    const netByAccount = new Map<Account, number>();
    const bump = (name: Account, delta: number) => {
      netByAccount.set(name, (netByAccount.get(name) ?? 0) + delta);
    };

    for (const t of monthTxs) {
      if (t.type === "income") {
        income += t.amount;
        bump(t.account, t.amount);
      }

      if (t.type === "expense") {
        expense += t.amount;
        bump(t.account, -t.amount);
      }

      if (t.type === "transfer") {
        bump(t.from, -t.amount);
        bump(t.to, t.amount);
      }
    }

    const primary = (primaryAccount ?? (accounts[0] ?? ("Main" as Account))) as Account;
    const available = netByAccount.get(primary) ?? 0;

    let savings = 0;
    for (const [name, value] of netByAccount.entries()) {
      if (name !== primary) savings += value;
    }

    return {
      available,
      netFlow: income - expense,
      income,
      expense,
      savings,
      netByAccount,
    };
  }, [monthTxs, accounts, primaryAccount]);

  const balances = useMemo(() => {
    const map = new Map<Account, number>();
    const bump = (name: Account, delta: number) => {
      map.set(name, (map.get(name) ?? 0) + delta);
    };

    for (const t of monthAllTxs) {
      if (t.type === "income") bump(t.account, t.amount);
      if (t.type === "expense") bump(t.account, -t.amount);
      if (t.type === "transfer") {
        bump(t.from, -t.amount);
        bump(t.to, t.amount);
      }
    }

    return map;
  }, [monthAllTxs]);

  // -------- Expense Breakdown (Top + Others + All modal) --------
  const expenseBreakdown = useMemo(() => {
    const expenses = monthTxs.filter((t) => t.type === "expense");

    const byCat = new Map<string, number>();
    for (const t of expenses) {
      const cat =
        (t.type === "expense" && (t as Extract<Tx, { type: "expense" }>).category) || "Uncategorized";
      byCat.set(cat, (byCat.get(cat) ?? 0) + t.amount);
    }

    const items = Array.from(byCat.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);

    const total = items.reduce((sum, x) => sum + x.amount, 0);

    const topN = 6;
    const top = items.slice(0, topN).map((x) => ({
      ...x,
      pct: total > 0 ? (x.amount / total) * 100 : 0,
    }));

    const othersItems = items.slice(topN);
    const othersAmount = othersItems.reduce((s, x) => s + x.amount, 0);
    const others =
      othersAmount > 0
        ? {
            category: "Others",
            amount: othersAmount,
            pct: total > 0 ? (othersAmount / total) * 100 : 0,
          }
        : null;

    const all = items.map((x) => ({
      ...x,
      pct: total > 0 ? (x.amount / total) * 100 : 0,
    }));

    return { total, top, others, all };
  }, [monthTxs]);

  async function signIn() {
    setAuthBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthBusy(false);
    if (error) return alert(error.message);
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
    setOpen(false);
    setAcctOpen(false);
    setBreakdownOpen(false);
    setRulesOpen(false);
  }

  function resetForm() {
    const primary = primaryAccount ?? (accounts[0] ?? ("Main" as Account));
    const secondary = accounts.find((a) => a !== primary) ?? primary;

    setType("expense");
    setAccount(primary);
    setFrom(primary);
    setTo(secondary);

    setCategory("Uncategorized");
    setAmount("");
    setNote("");
    setDate(todayISO());
  }

  async function onAdd() {
    const clean = Number(String(amount).replaceAll(",", "").trim());
    if (!clean || clean <= 0) return alert("Enter a valid amount");

    let tx: Tx;

    // Auto-categorize ONLY when it’s an expense and category is still default-ish
    let finalCategory = category.trim() || "Uncategorized";
    if (type === "expense" && finalCategory.toLowerCase() === "uncategorized") {
      const hit = applyRules(note, rules);
      if (hit) finalCategory = hit;
    }

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
        type,
        account,
        category: finalCategory || "Uncategorized",
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
              : (tx as Extract<Tx, { type: "income" | "expense" }>).account ?? null,
          from_account: tx.type === "transfer" ? (tx as Extract<Tx, { type: "transfer" }>).from : null,
          to_account: tx.type === "transfer" ? (tx as Extract<Tx, { type: "transfer" }>).to : null,
          category:
            tx.type === "transfer"
              ? null
              : (tx as Extract<Tx, { type: "income" | "expense" }>).category ?? null,
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

  // ✅ SIGNED OUT: Fullscreen background + login card on top (logo inside card)
  if (!session) {
    return (
      <div className="relative min-h-[100dvh] w-full overflow-hidden bg-zinc-950 text-white">
        <div className="absolute inset-0 z-0">
          <img src={leftHero} alt="" className="h-full w-full object-cover" draggable={false} loading="eager" />
        </div>

        <div className="pointer-events-none absolute inset-0 z-10">
          <div className="absolute inset-0 bg-black/15" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/45" />
          <div className="absolute -top-48 left-[-15%] h-[560px] w-[560px] rounded-full bg-lime-400/14 blur-3xl" />
          <div className="absolute bottom-[-260px] right-[-12%] h-[700px] w-[700px] rounded-full bg-lime-400/10 blur-3xl" />
        </div>

        <div className="relative z-20 min-h-[100dvh] flex items-center px-4 sm:px-8 py-10">
          <div className="w-full max-w-6xl mx-auto">
            <div className="flex justify-center md:justify-end">
              <div className="w-full max-w-md rounded-3xl border border-white/10 bg-zinc-950/55 backdrop-blur-xl p-8 shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
                <div className="flex justify-center">
                  <img
                    src={logo}
                    alt="Monetyz"
                    className="h-[46px] w-[190px] object-contain drop-shadow-[0_0_18px_rgba(163,230,53,0.22)]"
                    loading="eager"
                    draggable={false}
                  />
                </div>

                <div className="mt-6 flex items-center justify-between gap-4">
                  <h2 className="text-3xl font-semibold">{authMode === "signin" ? "Sign in" : "Create account"}</h2>

                  <button
                    type="button"
                    onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}
                    className="text-sm text-zinc-300 hover:text-white transition"
                  >
                    {authMode === "signin" ? "Sign up" : "Have an account"}
                  </button>
                </div>

                <div className="mt-8 space-y-4">
                  <div>
                    <label className="text-sm text-zinc-300">Email</label>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                      placeholder="you@example.com"
                      className="mt-2 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/60 px-4 py-3 text-zinc-100 transition focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-lime-400/40"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-zinc-300">Password</label>
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      placeholder="••••••••"
                      className="mt-2 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/60 px-4 py-3 text-zinc-100 transition focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-lime-400/40"
                    />
                    <p className="text-xs text-zinc-400 mt-2">Use 8+ chars.</p>
                  </div>

                  <button
                    disabled={authBusy}
                    onClick={authMode === "signin" ? signIn : signUp}
                    className="mt-2 w-full rounded-full bg-lime-400 text-black px-8 py-3 text-base font-semibold transition hover:opacity-95 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.18)] active:scale-[0.99] disabled:opacity-60"
                  >
                    {authBusy
                      ? authMode === "signin"
                        ? "Signing in…"
                        : "Creating…"
                      : authMode === "signin"
                        ? "Sign in"
                        : "Create account"}
                  </button>

                  <p className="text-xs text-zinc-400">
                    Cloud data is private per account (RLS). Sign in on another device to see your own transactions.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ✅ SIGNED IN: dashboard
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
              Cloud: Connected ✅{cloudBusy ? <span className="ml-2">(syncing…)</span> : null}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline text-sm text-zinc-500">{session.user.email}</span>
            <button
              onClick={signOut}
              className="rounded-full border border-zinc-800 px-4 py-2 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
            >
              Sign out
            </button>
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
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>

          <span className="text-sm text-zinc-500">Showing totals for {month}</span>

          <button
            type="button"
            onClick={() => setRulesOpen(true)}
            className="ml-auto rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-2 text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
          >
            Rules
          </button>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <Card label={`Available (${primaryAccount})`} value={formatLKR(totals.available)} />
          <Card label="Income" value={formatLKR(totals.income)} />
          <Card label="Expenses" value={formatLKR(totals.expense)} />
          <div className="rounded-2xl bg-zinc-900/40 p-6 border border-zinc-800 transition duration-200 ease-out hover:bg-zinc-900/60 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.08)]">
            <p className="text-sm text-zinc-400">Savings (All except primary)</p>
            <p className="text-3xl font-semibold mt-2">{formatLKR(totals.savings)}</p>
            <p className="text-sm text-zinc-500 mt-3">
              Primary: <span className="text-zinc-300">{primaryAccount}</span>
              {accountsBusy ? <span className="ml-2">(loading accounts…)</span> : null}
            </p>
          </div>
        </div>

        {/* Account balance strip (dynamic) + Manage */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <FilterPill
            label="All"
            value={formatLKR(Array.from(balances.values()).reduce((s, v) => s + v, 0))}
            active={accountFilter === "All"}
            onClick={() => setAccountFilter("All")}
          />

          {accounts.map((a) => (
            <FilterPill
              key={a}
              label={a}
              value={formatLKR(balances.get(a) ?? 0)}
              active={accountFilter === a}
              onClick={() => setAccountFilter(a)}
            />
          ))}

          <button
            type="button"
            onClick={() => setAcctOpen(true)}
            className="ml-auto rounded-2xl border border-zinc-800 bg-zinc-900/30 px-4 py-3 text-left transition hover:bg-zinc-900 hover:border-zinc-700 active:scale-[0.99]"
          >
            <p className="text-xs text-zinc-500">Accounts</p>
            <p className="text-lg font-semibold">Manage</p>
          </button>
        </div>

        <p className="mt-3 text-sm text-zinc-500">
          Net flow (Income − Expenses): {formatLKR(totals.netFlow)}
          <span className="mx-2">•</span>
          Available shows what’s left in <span className="text-zinc-300">{primaryAccount}</span> after transfers.
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
                          t.type === "income" && "border-emerald-700/60 bg-emerald-500/10 text-emerald-200",
                          t.type === "expense" && "border-rose-700/60 bg-rose-500/10 text-rose-200",
                          t.type === "transfer" && "border-sky-700/60 bg-sky-500/10 text-sky-200",
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
                          {t.category ? <span className="text-zinc-400 text-sm">• {t.category}</span> : null}
                        </>
                      )}
                    </div>

                    <div className="mt-2 text-lg font-semibold">{formatLKR(t.amount)}</div>
                    {t.note ? <div className="text-zinc-400 text-sm mt-1">{t.note}</div> : null}
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

        {/* Monthly Expense Breakdown */}
        <div className="mt-10">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Expense breakdown</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Top categories for {month}
                {accountFilter !== "All" ? ` • ${accountFilter}` : ""}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-sm text-zinc-400">
                Total: <span className="text-zinc-200">{formatLKR(expenseBreakdown.total)}</span>
              </div>

              <button
                type="button"
                onClick={() => setBreakdownOpen(true)}
                className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
              >
                View all
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6 transition duration-200 ease-out hover:bg-zinc-900/45 hover:border-zinc-700 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.06)]">
            {expenseBreakdown.total === 0 ? (
              <div className="text-zinc-400">No expenses yet for this month.</div>
            ) : (
              <div className="space-y-4">
                {expenseBreakdown.top.map((x) => (
                  <div key={x.category}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-zinc-200">{x.category}</p>
                        <p className="text-xs text-zinc-500">{x.pct.toFixed(0)}%</p>
                      </div>

                      <div className="shrink-0 text-sm font-semibold text-zinc-200">{formatLKR(x.amount)}</div>
                    </div>

                    <div className="mt-2 h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-lime-400/80"
                        style={{ width: `${Math.max(2, x.pct)}%` }}
                      />
                    </div>
                  </div>
                ))}

                {expenseBreakdown.others ? (
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-zinc-200">{expenseBreakdown.others.category}</p>
                        <p className="text-xs text-zinc-500">{expenseBreakdown.others.pct.toFixed(0)}%</p>
                      </div>

                      <div className="shrink-0 text-sm font-semibold text-zinc-200">
                        {formatLKR(expenseBreakdown.others.amount)}
                      </div>
                    </div>

                    <div className="mt-2 h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-lime-400/45"
                        style={{ width: `${Math.max(2, expenseBreakdown.others.pct)}%` }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Expense Breakdown - View All Modal */}
      {breakdownOpen ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="w-full max-w-xl rounded-3xl bg-zinc-950/90 border border-zinc-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">All expense categories</h3>
                <p className="text-sm text-zinc-500 mt-1">
                  {month}
                  {accountFilter !== "All" ? ` • ${accountFilter}` : ""}
                </p>
              </div>

              <button onClick={() => setBreakdownOpen(false)} className="text-zinc-400 hover:text-white transition">
                ✕
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {expenseBreakdown.total === 0 ? (
                <div className="text-zinc-400">No expenses yet.</div>
              ) : (
                expenseBreakdown.all.map((x) => (
                  <div key={x.category} className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-zinc-200">{x.category}</p>
                        <p className="text-xs text-zinc-500">{x.pct.toFixed(1)}%</p>
                      </div>
                      <div className="shrink-0 text-sm font-semibold text-zinc-200">{formatLKR(x.amount)}</div>
                    </div>
                    <div className="mt-2 h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                      <div className="h-full rounded-full bg-lime-400/70" style={{ width: `${Math.max(2, x.pct)}%` }} />
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-5 text-sm text-zinc-400">
              Total: <span className="text-zinc-200">{formatLKR(expenseBreakdown.total)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Manage Accounts Modal */}
      {acctOpen ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="w-full max-w-lg rounded-3xl bg-zinc-950/90 border border-zinc-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Manage Accounts</h3>
                <p className="text-xs text-zinc-500 mt-1">Primary account = “Available”</p>
              </div>
              <button
                onClick={() => {
                  setAcctOpen(false);
                  setNewAcct("");
                }}
                className="text-zinc-400 transition hover:text-white hover:scale-105"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex gap-3">
              <input
                value={newAcct}
                onChange={(e) => setNewAcct(e.target.value)}
                placeholder="e.g. Emergency Fund"
                className="flex-1 rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 text-zinc-200 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
              />
              <button
                disabled={!session || accountsBusy}
                onClick={async () => {
                  const clean = newAcct.trim();
                  if (!clean) return;

                  if (accounts.map((a) => a.toLowerCase()).includes(clean.toLowerCase())) {
                    alert("Account already exists");
                    return;
                  }

                  try {
                    setAccountsBusy(true);
                    // Insert with sort_order at end
                    const nextOrder = accountRows.length ? (accountRows[accountRows.length - 1].sort_order ?? accountRows.length) + 1 : 0;

                    const { error } = await supabase.from("accounts").insert({
                      name: clean,
                      sort_order: nextOrder,
                      is_primary: false,
                    });
                    if (error) throw error;

                    setNewAcct("");
                    await refreshAccounts();
                  } catch (e) {
                    console.error(e);
                    alert("Failed to add account");
                  } finally {
                    setAccountsBusy(false);
                  }
                }}
                className="rounded-xl bg-lime-400 px-5 py-3 font-semibold text-black transition hover:opacity-95 disabled:opacity-60"
              >
                Add
              </button>
            </div>

            <div className="mt-6 space-y-2">
              {accountRows.map((r, idx) => {
                const a = r.name as Account;
                const isPrimary = a === primaryAccount;

                return (
                  <div key={a} className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-zinc-200">
                          {a} {isPrimary ? <span className="ml-2 text-xs text-lime-300">(Primary)</span> : null}
                        </p>
                        <p className="text-xs text-zinc-500">Balance: {formatLKR(balances.get(a) ?? 0)}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          disabled={idx === 0 || accountsBusy}
                          onClick={() => moveAccount(a, -1)}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-30"
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          disabled={idx === accountRows.length - 1 || accountsBusy}
                          onClick={() => moveAccount(a, 1)}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-30"
                          title="Move down"
                        >
                          ↓
                        </button>

                        <button
                          disabled={isPrimary || accountsBusy}
                          onClick={() => setPrimary(a)}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-1 text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-30"
                        >
                          Set primary
                        </button>

                        <button
                          disabled={isPrimary || accountsBusy}
                          onClick={async () => {
                            if (isPrimary) return;
                            if (!confirm(`Delete "${a}"?`)) return;
                            try {
                              setAccountsBusy(true);
                              const { error } = await supabase.from("accounts").delete().eq("name", a);
                              if (error) throw error;
                              await refreshAccounts();
                            } catch (e) {
                              console.error(e);
                              alert("Failed to delete account");
                            } finally {
                              setAccountsBusy(false);
                            }
                          }}
                          className="text-sm text-rose-300 transition hover:text-rose-200 disabled:opacity-30"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 text-xs text-zinc-500">
              Tip: Primary is your “Available” account. Reorder changes how accounts display everywhere.
            </p>
          </div>
        </div>
      ) : null}

      {/* Rules Modal */}
      {rulesOpen ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="w-full max-w-xl rounded-3xl bg-zinc-950/90 border border-zinc-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-semibold">Auto-categorize rules</h3>
                <p className="text-xs text-zinc-500 mt-1">
                  If Category is “Uncategorized”, we scan the Note for keywords and auto-fill it.
                </p>
              </div>
              <button onClick={() => setRulesOpen(false)} className="text-zinc-400 hover:text-white transition">
                ✕
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-sm text-zinc-400">Keyword</label>
                <input
                  value={ruleKeyword}
                  onChange={(e) => setRuleKeyword(e.target.value)}
                  placeholder="e.g. dialog, uber, fuel"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>

              <div>
                <label className="text-sm text-zinc-400">Category</label>
                <input
                  value={ruleCategory}
                  onChange={(e) => setRuleCategory(e.target.value)}
                  placeholder="e.g. Bills, Transport"
                  className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 text-zinc-200 focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                />
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  const k = ruleKeyword.trim();
                  const c = ruleCategory.trim();
                  if (!k || !c) return;

                  const exists = rules.some((r) => r.keyword.toLowerCase() === k.toLowerCase());
                  if (exists) {
                    alert("Keyword already exists. Use a different one.");
                    return;
                  }

                  setRules([{ id: crypto.randomUUID(), keyword: k, category: c }, ...rules]);
                  setRuleKeyword("");
                  setRuleCategory("");
                }}
                className="rounded-xl bg-lime-400 px-5 py-3 font-semibold text-black transition hover:opacity-95"
              >
                Add rule
              </button>

              <button
                onClick={() => {
                  if (!confirm("Clear all rules?")) return;
                  setRules([]);
                }}
                className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-5 py-3 font-semibold text-zinc-200 transition hover:bg-zinc-900 hover:border-zinc-700"
              >
                Clear all
              </button>
            </div>

            <div className="mt-6 space-y-2">
              {rules.length === 0 ? (
                <div className="text-zinc-400">No rules yet. Add one above 👆</div>
              ) : (
                rules.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">
                        <span className="text-zinc-400">If note has</span> “{r.keyword}”
                      </p>
                      <p className="text-sm text-zinc-200 truncate">
                        <span className="text-zinc-400">→ set category</span> “{r.category}”
                      </p>
                    </div>
                    <button
                      onClick={() => setRules(rules.filter((x) => x.id !== r.id))}
                      className="text-sm text-rose-300 hover:text-rose-200 transition"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>

            <p className="mt-4 text-xs text-zinc-500">
              Example: keyword “dialog” → category “Bills”. Then add an expense with note “Dialog bill”, keep category as
              Uncategorized, and it’ll auto-fill.
            </p>
          </div>
        </div>
      ) : null}

      {/* Add Transaction Modal */}
      {open ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-3xl bg-zinc-950/80 border border-zinc-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Add Transaction</h3>
              <button onClick={() => setOpen(false)} className="text-zinc-400 transition hover:text-white hover:scale-105">
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
                      {accounts.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400">To</label>
                    <select
                      value={to}
                      onChange={(e) => setTo(e.target.value as Account)}
                      className="mt-2 w-full rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-lime-400/20 focus:border-lime-400/30"
                    >
                      {accounts.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
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
                    {accounts.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 mt-2">
                    Income/Expense affects totals. Use multiple accounts to track savings buckets.
                  </p>
                </div>
              )}

              {type === "transfer" ? null : (
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-zinc-400">Category</label>
                    <button
                      type="button"
                      onClick={() => {
                        if (type !== "expense") return;
                        const hit = applyRules(note, rules);
                        if (hit) setCategory(hit);
                        else alert("No rule matched this note.");
                      }}
                      className="text-xs text-zinc-400 hover:text-white transition"
                      title="Try auto-categorize using rules"
                    >
                      Auto-fill
                    </button>
                  </div>

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
                MVP note: Available (primary) changes with transfers. Net flow = Income − Expenses.
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
    <div className="rounded-2xl bg-zinc-900/40 p-6 border border-zinc-800 transition duration-200 ease-out hover:bg-zinc-900/60 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-[0_0_0_6px_rgba(163,230,53,0.06)]">
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