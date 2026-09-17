export type Row = Record<string, any>;
export function power(status: unknown) {
  return (
    (
      {
        0: "unknown",
        1: "on",
        2: "off",
        3: "expired",
        4: "expired",
        10: "starting",
        11: "configuring",
      } as Record<string, string>
    )[String(status)] || "unknown"
  );
}
export function providerDate(date: Date, zone: string, seconds = false) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${seconds ? ":" + get("second") : ""}`;
}
export function expiresAt(value: unknown) {
  const n = Number(value);
  const d =
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value))
      ? new Date(n < 1e12 ? n * 1000 : n)
      : new Date(String(value));
  return Number.isFinite(+d) ? +d : 0;
}
export class DuoPlus {
  private cooldown = 0;
  constructor(
    private key: string,
    private guard: () => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {}
  async call(endpoint: string, payload: Row) {
    if (Date.now() < this.cooldown) throw Error("Provider cooldown");
    await this.guard();
    const r = await this.fetcher(
      "https://openapi.duoplus.net/api/v1/" + endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DuoPlus-API-Key": this.key,
          Lang: "en",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      },
    );
    let json;
    try {
      json = await r.json();
    } catch {
      throw Error("Provider response unreadable");
    }
    if (r.status === 429 || Number(json.code) === 429)
      this.cooldown = Date.now() + 60000;
    if (!r.ok || Number(json.code) !== 200 || !json.data)
      throw Error("Provider call failed");
    return json.data as Row;
  }
  async list(endpoint: string, payload: Row = {}) {
    const rows: Row[] = [];
    for (let page = 1; page <= 100; page++) {
      const d = await this.call(endpoint, { ...payload, page, pagesize: 100 });
      if (!Array.isArray(d.list)) throw Error("Invalid inventory response");
      rows.push(...d.list);
      const total = Number(d.total_page);
      if (
        (Number.isFinite(total) && page >= total) ||
        (!Number.isFinite(total) && d.list.length < 100)
      )
        return rows;
    }
    throw Error("Incomplete inventory");
  }
  async setPower(id: string, on: boolean) {
    const d = await this.call(
      on ? "cloudPhone/powerOn" : "cloudPhone/powerOff",
      { image_ids: [id] },
    );
    if (d.fail?.length) throw Error("Power request failed");
  }
}
