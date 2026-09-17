import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { admin } from "../lib/admin";
import { DuoPlus, power, expiresAt, providerDate, type Row } from "./provider";
import { signCapture } from "../lib/execution/token";
const worker = randomUUID(),
  enabled = process.env.SEARCH_WORKER_ENABLED === "true";
const activeStates = [
  "booting",
  "submitting",
  "submitted",
  "running",
  "stopping",
  "attention",
];
let lastTick: string | null = null,
  lastError: string | null = null,
  busy = false,
  stopping = false;
const db = admin();
async function rpc(name: string, args: Row) {
  const r = await db.rpc(name, args);
  if (r.error) throw Error("Database operation failed");
  return r.data;
}
async function guard() {
  if (stopping || !(await rpc("search_worker_leader", { p_token: worker })))
    throw Error("Worker lease unavailable");
  for (let i = 0; i < 4; i++) {
    if (await rpc("search_api_gate", { p_token: worker })) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Provider gate busy");
}
const provider = new DuoPlus(process.env.DUOPLUS_API_KEY || "", guard);
const zone = process.env.DUOPLUS_TIMEZONE || "UTC";
async function change(run: Row, status: string, extra: Row = {}) {
  const ok = await rpc("search_run_update", {
    p_token: worker,
    p_id: run.id,
    p_expected: run.status,
    p_status: status,
    p_task: extra.task || null,
    p_outcome: extra.outcome || null,
    p_error: extra.error || null,
  });
  if (!ok) throw Error("Run state changed or lease expired");
  run.status = status;
  if (extra.outcome) run.provider_outcome = extra.outcome;
}
async function advance(run: Row, device: Row, observed: Row | undefined) {
  const state = power(observed?.status);
  if (run.status === "booting") {
    if (state === "on") {
      const { data: r, error } = await db
        .from("search_routines")
        .select("*")
        .eq("id", run.routine_id)
        .single();
      if (error || !r) throw Error("Routine missing");
      const { data: t } = await db
        .from("search_templates")
        .select("capture_enabled,enabled")
        .eq("id", r.template_id)
        .single();
      if (!t?.enabled) {
        await change(run, "stopping", {
          outcome: "failed",
          error: "Template disabled before submission",
        });
        return;
      }
      const config = { ...r.variables };
      if (t.capture_enabled) {
        if (
          !process.env.CAPTURE_SIGNING_SECRET ||
          process.env.CAPTURE_SIGNING_SECRET.length < 32 ||
          !process.env.APP_URL?.startsWith("https://")
        ) {
          await change(run, "stopping", {
            outcome: "failed",
            error: "Capture integration not configured",
          });
          return;
        }
        for (const [key, value] of Object.entries({
          stakeout_run_id: run.id,
          stakeout_capture_token: signCapture(
            run.id,
            process.env.CAPTURE_SIGNING_SECRET,
          ),
          stakeout_capture_url: process.env.APP_URL + "/api/captures",
        }))
          config[key] = { key, value, type: "string", required: true };
      }
      await change(run, "submitting");
      try {
        await provider.call("automation/addTask", {
          name: run.provider_name,
          remark: "Stakeout managed observation",
          template_id: r.template_id,
          template_type: r.template_type,
          images: [
            {
              image_id: device.provider_id,
              issue_at: providerDate(new Date(Date.now() + 120000), zone),
              config,
            },
          ],
        });
        await change(run, "submitted");
      } catch {
        await change(run, "attention", {
          error:
            "Submission response uncertain; reservation retained. Reconciliation required.",
        });
      }
      return;
    }
    if (Date.now() - Date.parse(run.started_at) > 180000)
      await change(run, "attention", {
        error: "Device startup unconfirmed; reservation retained.",
      });
    return;
  }
  if (
    ["submitted", "submitting", "running", "attention"].includes(run.status)
  ) {
    const tasks = (
      await provider.list("automation/taskList", {
        name: run.provider_name,
        issue_at_start: providerDate(
          new Date(Date.parse(run.started_at) - 86400000),
          zone,
          true,
        ),
        issue_at_end: providerDate(new Date(Date.now() + 86400000), zone, true),
      })
    ).filter((t) => t.name === run.provider_name);
    if (tasks.length !== 1) {
      if (tasks.length > 1 || Date.now() - Date.parse(run.started_at) > 600000)
        await change(run, "attention", {
          error: tasks.length
            ? "Multiple provider tasks found; operator review required."
            : "Task not confirmed; no automatic resubmission.",
        });
      return;
    }
    const task = tasks[0],
      status = Number(task.status);
    if ([3, 4, 5].includes(status)) {
      await change(run, "stopping", {
        task: String(task.id),
        outcome: status === 3 ? "completed" : "failed",
      });
      return;
    }
    if (status === 1 || status === 0) {
      await change(run, status === 1 ? "running" : "submitted", {
        task: String(task.id),
      });
      return;
    }
    await change(run, "attention", {
      error: "Provider task is paused or unknown; slot retained.",
    });
    return;
  }
  if (run.status === "stopping") {
    // Acknowledging powerOff is not proof of shutdown.
    const info = await provider.call("cloudPhone/status", {
      image_ids: [device.provider_id],
    });
    const current = Array.isArray(info.list)
      ? info.list.find((x: Row) => x.id === device.provider_id)
      : undefined;
    const actual = power(current?.status);
    if (actual === "off") {
      await change(
        run,
        run.provider_outcome === "completed" ? "completed" : "failed",
      );
      return;
    }
    if (actual === "on") await provider.setPower(device.provider_id, false);
  }
}
async function tick() {
  if (busy || stopping || !enabled) return;
  busy = true;
  try {
    if (!process.env.DUOPLUS_API_KEY)
      throw Error("Managed provider key missing");
    if (!(await rpc("search_worker_leader", { p_token: worker }))) return;
    const inventory = await provider.list("cloudPhone/list");
    if (inventory.some((x) => typeof x.id !== "string"))
      throw Error("Invalid device inventory");
    const allSubs = new Map<string, Row>();
    for (const free_status of [0, 1])
      for (const sub of await provider.list("subscriptionStartup/list", {
        free_status,
      }))
        allSubs.set(String(sub.id), sub);
    const verified = [...allSubs.values()].filter(
      (s) => expiresAt(s.expired_at) > Date.now(),
    ).length;
    const configuredCap = Number(process.env.SEARCH_MAX_SLOTS || 0);
    if (!Number.isInteger(configuredCap) || configuredCap < 0)
      throw Error("Invalid operator capacity");
    const capacity = Math.min(verified, configuredCap);
    const [{ data: runs, error: re }, { data: devices, error: de }] =
      await Promise.all([
        db
          .from("search_runs")
          .select("*")
          .in("status", activeStates)
          .order("started_at"),
        db.from("search_managed_devices").select("*"),
      ]);
    if (re || de) throw Error("State unavailable");
    const assigned = new Map((devices || []).map((d) => [d.id, d]));
    const reserved = new Set(
      (runs || []).map((r) => assigned.get(r.device_id)?.provider_id),
    );
    const external = inventory.filter(
      (i) =>
        !reserved.has(i.id) && !["off", "expired"].includes(power(i.status)),
    ).length;
    await rpc("search_worker_inventory", {
      p_token: worker,
      p_external: external,
      p_capacity: capacity,
      p_power: Object.fromEntries(
        inventory.map((i) => [i.id, power(i.status)]),
      ),
    });
    for (const run of runs || []) {
      const d = assigned.get(run.device_id);
      if (!d) throw Error("Assigned device unavailable");
      await advance(
        run,
        d,
        inventory.find((i) => i.id === d.provider_id),
      );
    }
    // Reconcile on the next tick before filling another slot; inventory must be fresh.
    if (
      !(runs || []).length ||
      Date.now() - Date.parse(lastTick || "1970-01-01") < 30000
    ) {
      const claimed = await rpc("search_claim", { p_token: worker });
      if (claimed?.length) {
        const run = claimed[0],
          d = assigned.get(run.device_id);
        if (!d) throw Error("Device missing");
        try {
          await provider.setPower(d.provider_id, true);
        } catch {
          await change(run, "attention", {
            error: "Power-on response uncertain; reservation retained.",
          });
        }
      }
    }
    lastTick = new Date().toISOString();
    lastError = null;
  } catch {
    lastError =
      "Worker paused this cycle; inspect credentials, provider availability, and attention runs.";
  } finally {
    busy = false;
  }
}
const server = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, enabled, lastTick, lastError }));
});
server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
const timer = setInterval(() => void tick(), 5000);
void tick();
process.on("SIGTERM", () => {
  stopping = true;
  clearInterval(timer);
  server.close();
});
