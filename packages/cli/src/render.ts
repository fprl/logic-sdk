// Terminal output with no dependencies: colors from node:util (they turn off by themselves when piped or
// with NO_COLOR), and a few layout helpers.
import { styleText } from "node:util";
import type { Loc } from "./analyze.ts";
import type { Problem } from "./check.ts";
import type { JsonSchema } from "./project.ts";

type Format = Parameters<typeof styleText>[0];
export const paint = (format: Format, text: string, stream: NodeJS.WriteStream = process.stdout) =>
  styleText(format, text, { stream });

export const dim = (text: string) => paint("dim", text);
export const bold = (text: string) => paint("bold", text);

const KIND_COLOR = { query: "blue", mutation: "magenta", action: "yellow", listener: "cyan" } as const;
export const kind = (k: keyof typeof KIND_COLOR) => paint(KIND_COLOR[k], k);

// eslint-disable-next-line no-control-regex
const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visible(text)));

/** Columns sized to their content. On a terminal, the last column is cut to fit the width. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ""))));
  const columns = process.stdout.isTTY ? process.stdout.columns : Infinity;
  const used = widths.slice(0, -1).reduce((a, b) => a + b + 3, 0);
  const fit = (cell: string, i: number) => {
    if (i < headers.length - 1) return pad(cell, widths[i]!);
    const room = columns - used;
    return visible(cell) > room && room > 10 ? cell.slice(0, room - 1) + "…" : cell;
  };
  const line = (cells: string[]) => cells.map(fit).join("   ").trimEnd();
  return [dim(line(headers)), ...rows.map(line)].join("\n");
}

export const where = (at: Loc | null) => (at ? `${at.file}:${at.line}:${at.column}` : "");

/** A JSON Schema as a short TypeScript-like shape: { bookingId: uuid, guestEmail?: email } */
export function shape(schema: JsonSchema | null, depth = 0): string {
  if (!schema) return dim("unknown");
  if (depth > 2) return "{…}";
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((s: JsonSchema) => shape(s, depth)).join(" | ");
  switch (schema.type) {
    case "object": {
      const required = new Set<string>(schema.required ?? []);
      const props = Object.entries(schema.properties ?? {}).map(
        ([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${shape(v as JsonSchema, depth + 1)}`,
      );
      return props.length ? `{ ${props.join(", ")} }` : "{}";
    }
    case "array":
      return `${shape(schema.items ?? null, depth + 1)}[]`;
    case "string":
      return schema.format ?? "string";
    case "integer":
      return "int";
    case undefined:
      return dim("unknown");
    default:
      return Array.isArray(schema.type) ? schema.type.join(" | ") : String(schema.type);
  }
}

export function diagnostic(p: Problem): string {
  const mark = p.severity === "error" ? paint(["red", "bold"], "✗") : paint(["yellow", "bold"], "!");
  return [
    `${mark} ${bold(p.code)}  ${dim(where(p.at))}`.trimEnd(),
    `  ${p.message}`,
    `  ${paint("green", "fix:")} ${p.fix}`,
  ].join("\n");
}
