import { XMLParser, XMLValidator } from "fast-xml-parser";
export function visibleText(xml: string, width: number, height: number) {
  if (
    Buffer.byteLength(xml) > 2_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw Error("Invalid or unsafe XML");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
  }).parse(xml);
  if (!parsed.hierarchy) throw Error("UIAutomator hierarchy required");
  const result: { text: string; bounds: number[] }[] = [];
  let count = 0;
  function walk(value: unknown, depth: number) {
    if (depth > 100) throw Error("XML depth exceeded");
    if (!value || typeof value !== "object") return;
    for (const node of Array.isArray(value) ? value : [value]) {
      if (++count > 30000) throw Error("XML node limit exceeded");
      const n = node as Record<string, unknown>;
      const b = String(n.bounds || "").match(
        /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/,
      );
      const text = String(n.text || n["content-desc"] || "").trim();
      if (
        b &&
        text &&
        n["visible-to-user"] !== false &&
        n["visible-to-user"] !== "false"
      ) {
        const [l, t, r, bottom] = b.slice(1).map(Number);
        if (
          r > l &&
          bottom > t &&
          r > 0 &&
          bottom > 0 &&
          l < width &&
          t < height
        )
          result.push({ text: text.slice(0, 4000), bounds: [l, t, r, bottom] });
      }
      if (n.node) walk(n.node, depth + 1);
    }
  }
  walk(parsed.hierarchy.node, 0);
  return result;
}
export function fileSignature(kind: string, mime: string, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (kind === "xml") return !b.includes(0);
  if (mime === "image/png")
    return b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return b[0] === 255 && b[1] === 216 && b[2] === 255;
  return mime === "video/mp4" && b.subarray(4, 8).toString() === "ftyp";
}
