import { z } from "zod";
export const scheduleInput = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  campaignId: z.uuid(),
  deviceId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  templateId: z.string().min(1).max(128),
  surface: z.string().min(1).max(80),
  keyword: z.string().max(200),
  variables: z.record(z.string().max(100), z.string().max(4000)),
  startAt: z.iso.datetime(),
  count: z.number().int().min(1).max(45),
  intervalDays: z.number().int().min(1).max(30),
});
export const artifactInput = z
  .object({
    kind: z.enum(["xml", "screenshot", "video"]),
    mime: z.enum([
      "application/xml",
      "text/xml",
      "image/png",
      "image/jpeg",
      "video/mp4",
    ]),
    bytes: z.number().int().positive().max(268435456),
  })
  .refine((x) =>
    x.kind === "xml"
      ? ["application/xml", "text/xml"].includes(x.mime) && x.bytes <= 2_000_000
      : x.kind === "screenshot"
        ? ["image/png", "image/jpeg"].includes(x.mime) && x.bytes <= 15_000_000
        : x.mime === "video/mp4",
  );
export const captureInput = z
  .object({
    id: z.uuid(),
    stage: z.string().regex(/^[a-z0-9_-]{1,80}$/),
    observedAt: z.iso.datetime(),
    context: z.object({
      surface: z.string().min(1).max(80),
      keyword: z.string().max(200),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      locationVerified: z.boolean(),
      locationEvidence: z.string().max(500),
      viewport: z.object({
        width: z.number().int().min(1).max(10000),
        height: z.number().int().min(1).max(10000),
      }),
    }),
    artifacts: z.array(artifactInput).min(1).max(3),
  })
  .refine(
    (x) => new Set(x.artifacts.map((a) => a.kind)).size === x.artifacts.length,
    "Only one artifact per kind",
  );
export function resolveVariables(
  schema: Record<string, { type: string; required: boolean }>,
  values: Record<string, string>,
) {
  const result: Record<
    string,
    { key: string; value: string; type: string; required: boolean }
  > = {};
  for (const key of Object.keys(values))
    if (!schema[key] || key.startsWith("stakeout_"))
      throw Error("Unknown or reserved template variable");
  for (const [key, rule] of Object.entries(schema)) {
    if (key.startsWith("stakeout_")) continue;
    const value = values[key] ?? "";
    if (rule.required && !value.trim())
      throw Error(`Required variable: ${key}`);
    if (!["string", "textarea", "number", "boolean"].includes(rule.type))
      throw Error("This template variable type needs operator setup");
    if (rule.type === "number" && value && !Number.isFinite(Number(value)))
      throw Error(`Invalid number: ${key}`);
    if (rule.type === "boolean" && value && !["true", "false"].includes(value))
      throw Error(`Invalid boolean: ${key}`);
    result[key] = { key, value, type: rule.type, required: rule.required };
  }
  return result;
}
