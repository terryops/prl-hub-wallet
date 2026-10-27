// Read-only address history, matching NockScan in the iOS NockClient.swift.
// Accept is the only request header: nockscan refuses CORS preflights.
export type ScanEntry = {
  txId: string; kind: "received" | "mined" | "sent"; height: number; time: number;
  amount: string; fee: string; counterparties: string[];
};
export type ScanPage = { entries: ScanEntry[]; hasMore: boolean; count: number };
const uint = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^\d+$/.test(v) && BigInt(v) <= 0xffffffffffffffffn) return BigInt(v).toString();
  return undefined;
};
export function parseScan(value: unknown): ScanPage {
  const o = value as { transactions?: unknown; pagination?: { hasMore?: unknown } } | null;
  if (!Array.isArray(o?.transactions)) throw new Error("nockscan_malformed");
  const entries = o.transactions.flatMap((raw): ScanEntry[] => {
    if (!raw || typeof raw !== "object") return [];
    const t = raw as Record<string, unknown>, height = uint(t.blockHeight), timestamp = uint(t.timestamp), amount = uint(t.amount);
    if (typeof t.txId !== "string" || !t.txId || !["received", "sent"].includes(String(t.type)) || height === undefined || timestamp === undefined || amount === undefined) return [];
    if (!Number.isSafeInteger(Number(height)) || !Number.isSafeInteger(Number(timestamp) * 1000)) return [];
    return [{ txId: t.txId, kind: t.type === "sent" ? "sent" : t.isCoinbase === true ? "mined" : "received",
      height: Number(height), time: Number(timestamp) * 1000, amount, fee: uint(t.fee) ?? "0",
      counterparties: Array.isArray(t.counterparties) ? t.counterparties.filter((s): s is string => typeof s === "string") : [] }];
  });
  return { entries, hasMore: o.pagination?.hasMore === true && o.transactions.length > 0, count: o.transactions.length };
}
export class NockScan {
  private transport?: typeof fetch;
  // No stand-in: the global fetch, looked up at each call. Kept as a property and called as a method,
  // the browser's fetch throws "Illegal invocation".
  constructor(transport?: typeof fetch) { this.transport = transport; }
  async page(address: string, limit: number, offset: number): Promise<ScanPage> {
    const query = new URLSearchParams({ address, limit: String(limit), offset: String(offset) });
    const url = `https://nockscan.com/api/v1/address?${query}`;
    const init: RequestInit = { headers: { Accept: "application/json" }, credentials: "omit", signal: AbortSignal.timeout(20000) };
    const response = await (this.transport ? this.transport(url, init) : fetch(url, init));
    if (response.status === 404) return { entries: [], hasMore: false, count: 0 };
    if (!response.ok) throw new Error(`nockscan_http_${response.status}`);
    return parseScan(await response.json());
  }
}
