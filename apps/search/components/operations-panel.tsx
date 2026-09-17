"use client";
import { useEffect, useState } from "react";
import type { Campaign } from "../lib/campaign";
type Row = Record<string, any>;
export default function OperationsPanel({
  orgId,
  campaigns,
  role,
}: {
  orgId: string;
  campaigns: Campaign[];
  role: string;
}) {
  const [billing, setBilling] = useState<Row | null>(null),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [template, setTemplate] = useState(""),
    [captures, setCaptures] = useState<Row[] | null>(null),
    [selectedRun, setSelectedRun] = useState("");
  async function refresh() {
    const responses = await Promise.all([
      fetch("/api/billing/status?orgId=" + orgId),
      fetch("/api/schedules?orgId=" + orgId),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    if (responses.some((r) => !r.ok))
      throw Error(
        bodies.find((_, i) => !responses[i].ok)?.error ||
          "Operations unavailable",
      );
    setBilling(bodies[0]);
    setData(bodies[1]);
  }
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setBilling(null);
    setData(null);
    setCaptures(null);
    setSelectedRun("");
    setError("");
    (async () => {
      try {
        const rs = await Promise.all([
          fetch("/api/billing/status?orgId=" + orgId, {
            signal: controller.signal,
          }),
          fetch("/api/schedules?orgId=" + orgId, { signal: controller.signal }),
        ]);
        const bs = await Promise.all(rs.map((r) => r.json()));
        if (rs.some((r) => !r.ok))
          throw Error("Operations could not be loaded");
        if (alive) {
          setBilling(bs[0]);
          setData(bs[1]);
        }
      } catch {
        if (alive) setError("Operations could not be loaded. Try Refresh.");
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [orgId]);
  async function billingAction(action: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/billing/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      location.assign(d.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Billing unavailable");
    } finally {
      setBusy(false);
    }
  }
  const t = data?.templates?.find((x: Row) => x.id === template);
  const canManage = ["owner", "admin"].includes(role);
  const offer = billing?.offer;
  const subscription = billing?.subscription;
  const paid =
    subscription &&
    ["active", "trialing"].includes(subscription.status) &&
    Date.parse(subscription.valid_until) > Date.now();
  return (
    <section className="operations">
      <div className="panel-heading">
        <h2>Billing, schedules & evidence</h2>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            refresh()
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="panel operations-billing">
        <div>
          <h3>Subscription</h3>
          <p>
            {subscription?.status || "No subscription"}
            {paid
              ? ` · ${subscription.device_limit} devices · ${subscription.parallel_limit} parallel slots`
              : ""}
          </p>
          {offer && (
            <p>
              {offer.amount === null
                ? "Price available at checkout"
                : new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: offer.currency,
                  }).format(offer.amount / 100)}{" "}
              / {offer.interval} · {offer.devices} devices
            </p>
          )}
          {billing && !billing.configured && (
            <p>Billing connection is pending. Checkout is unavailable.</p>
          )}
        </div>
        {role === "owner" && (
          <div className="operations-actions">
            <button
              className="button primary"
              disabled={busy || !billing?.configured}
              onClick={() => void billingAction("checkout")}
            >
              Subscribe
            </button>
            <button
              className="button"
              disabled={busy || !billing?.configured || !subscription}
              onClick={() => void billingAction("portal")}
            >
              Manage billing
            </button>
          </div>
        )}
      </div>
      <div className="panel operations-schedule">
        <div className="panel-heading">
          <h3>Device task schedule</h3>
          <span className="muted">Times shown in your browser timezone</span>
        </div>
        {canManage && (
          <details>
            <summary>Create a scheduled routine</summary>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                const f = new FormData(e.currentTarget);
                const variables: Record<string, string> = {};
                for (const [key, value] of f.entries())
                  if (key.startsWith("var:"))
                    variables[key.slice(4)] = String(value);
                try {
                  const r = await fetch("/api/schedules", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: crypto.randomUUID(),
                      orgId,
                      campaignId: f.get("campaign"),
                      deviceId: f.get("device"),
                      name: f.get("name"),
                      templateId: template,
                      surface: f.get("surface"),
                      keyword: f.get("keyword"),
                      variables,
                      startAt: new Date(String(f.get("start"))).toISOString(),
                      count: Number(f.get("count")),
                      intervalDays: Number(f.get("interval")),
                    }),
                  });
                  const d = await r.json();
                  if (!r.ok) throw Error(d.error);
                  await refresh();
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Schedule unavailable",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="form-grid">
                <label>
                  Campaign
                  <select name="campaign" required>
                    <option value="">Choose campaign</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.business}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Assigned device
                  <select name="device" required>
                    <option value="">Choose device</option>
                    {data?.devices
                      ?.filter((d: Row) => d.enabled)
                      .map((d: Row) => (
                        <option value={d.id} key={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Routine name
                  <input name="name" required maxLength={120} />
                </label>
                <label>
                  Approved RPA template
                  <select
                    required
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                  >
                    <option value="">Choose template</option>
                    {data?.templates?.map((x: Row) => (
                      <option value={x.id} key={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Surface
                  <input
                    name="surface"
                    required
                    placeholder="Chrome · Local Finder"
                    maxLength={80}
                  />
                </label>
                <label>
                  Keyword
                  <input name="keyword" maxLength={200} />
                </label>
                <label>
                  First run (local time)
                  <input name="start" type="datetime-local" required />
                </label>
                <label>
                  Number of runs
                  <input
                    name="count"
                    type="number"
                    min={1}
                    max={45}
                    defaultValue={1}
                    required
                  />
                </label>
                <label>
                  Repeat every (days)
                  <input
                    name="interval"
                    type="number"
                    min={1}
                    max={30}
                    defaultValue={1}
                    required
                  />
                </label>
              </div>
              {t &&
                Object.entries(t.variable_schema as Record<string, Row>)
                  .filter(([key]) => !key.startsWith("stakeout_"))
                  .map(([key, rule]) => (
                    <label key={key}>
                      {key}
                      {rule.required ? " *" : ""}
                      <input
                        name={"var:" + key}
                        required={rule.required}
                        maxLength={4000}
                        placeholder={rule.type}
                      />
                    </label>
                  ))}
              <p className="hint">
                A paid plan, an assigned device, and an approved template are
                required. Daily and weekly routines are stored before dispatch;
                delayed tasks remain queued.
              </p>
              <button className="button primary" disabled={busy || !paid || !t}>
                Save schedule
              </button>
            </form>
          </details>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Routine</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data?.routines?.map((r: Row) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.enabled ? "Enabled" : "Paused"}</td>
                  <td>
                    {canManage && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const res = await fetch("/api/schedules", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                orgId,
                                routineId: r.id,
                                enabled: !r.enabled,
                              }),
                            });
                            if (!res.ok)
                              throw Error("Could not update routine");
                            await refresh();
                          } catch (e) {
                            setError(String(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {r.enabled ? "Pause future dispatch" : "Resume"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.routines?.length === 0 && (
          <p className="empty-ops">No routines scheduled yet.</p>
        )}
      </div>
      <div className="panel">
        <div className="panel-heading">
          <h3>Execution history</h3>
          <span className="muted">Latest 300 runs</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Task state</th>
                <th>Details</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {data?.runs?.map((r: Row) => (
                <tr key={r.id}>
                  <td>{new Date(r.due_at).toLocaleString()}</td>
                  <td>{r.status}</td>
                  <td>{r.last_error || "—"}</td>
                  <td>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={async () => {
                        setSelectedRun(r.id);
                        setCaptures(null);
                        setBusy(true);
                        try {
                          const res = await fetch(
                            "/api/evidence?orgId=" + orgId + "&runId=" + r.id,
                          );
                          const d = await res.json();
                          if (!res.ok) throw Error(d.error);
                          setCaptures(d.captures);
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      View captures
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.runs?.length === 0 && (
          <p className="empty-ops">
            No scheduled runs. Capture evidence appears after a real device
            uploads it.
          </p>
        )}
      </div>
      {selectedRun && (
        <section className="panel real-evidence">
          <h3>Capture evidence</h3>
          {captures?.length === 0 && (
            <p>
              No verified captures for this run yet. Task completion alone is
              not evidence capture.
            </p>
          )}
          {captures?.map((c) => (
            <article key={c.id}>
              <h3>
                {c.stage} · {new Date(c.observed_at).toLocaleString()}
              </h3>
              <p>
                {c.context.surface} · {c.context.keyword} · Location{" "}
                {c.context.locationVerified
                  ? "reported verified by capture worker"
                  : "unverified"}
              </p>
              <div className="capture-artifacts">
                {c.artifacts.map((a: Row) => (
                  <div key={a.path}>
                    {a.kind === "video" ? (
                      <video
                        src={a.url}
                        controls
                        preload="metadata"
                        onError={() =>
                          setError(
                            "Playback URL may have expired. Reopen the captures to refresh it.",
                          )
                        }
                      />
                    ) : a.kind === "screenshot" ? (
                      <img src={a.url} alt={"Device screenshot: " + c.stage} />
                    ) : (
                      <a
                        className="text-link"
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original UI XML
                      </a>
                    )}
                  </div>
                ))}
              </div>
              {c.visible_text && (
                <details>
                  <summary>Visible text extracted from XML</summary>
                  <ul>
                    {c.visible_text.map((n: Row, i: number) => (
                      <li key={i}>{n.text}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
