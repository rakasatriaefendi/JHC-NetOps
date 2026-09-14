import { createHash } from "node:crypto";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export class P12JsonNumber {
  constructor(readonly raw: string) {
    if (JSON_NUMBER.exec(raw)?.[0] !== raw) throw new TypeError("Invalid lossless JSON number");
  }
}

export function parseLosslessJson(input: string): unknown {
  let position = 0;
  const whitespace = (): void => {
    while (position < input.length && /\s/.test(input[position] ?? "")) position += 1;
  };
  const parseString = (): string => {
    const start = position;
    position += 1;
    while (position < input.length) {
      if (input[position] === "\\") { position += 2; continue; }
      if (input[position] === '"') {
        position += 1;
        return JSON.parse(input.slice(start, position)) as string;
      }
      position += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const parseObject = (): Readonly<Record<string, unknown>> => {
    position += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    whitespace();
    if (input[position] === "}") { position += 1; return result; }
    while (position < input.length) {
      whitespace();
      if (input[position] !== '"') throw new SyntaxError("Invalid JSON object key");
      const key = parseString();
      if (Object.hasOwn(result, key)) throw new SyntaxError("Duplicate JSON object key");
      whitespace();
      if (input[position] !== ":") throw new SyntaxError("Invalid JSON object separator");
      position += 1;
      result[key] = parseValue();
      whitespace();
      if (input[position] === "}") { position += 1; return result; }
      if (input[position] !== ",") throw new SyntaxError("Invalid JSON object delimiter");
      position += 1;
    }
    throw new SyntaxError("Unterminated JSON object");
  };
  const parseArray = (): readonly unknown[] => {
    position += 1;
    const result: unknown[] = [];
    whitespace();
    if (input[position] === "]") { position += 1; return result; }
    while (position < input.length) {
      result.push(parseValue());
      whitespace();
      if (input[position] === "]") { position += 1; return result; }
      if (input[position] !== ",") throw new SyntaxError("Invalid JSON array delimiter");
      position += 1;
    }
    throw new SyntaxError("Unterminated JSON array");
  };
  const parseValue = (): unknown => {
    whitespace();
    const character = input[position];
    if (character === '"') return parseString();
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (input.startsWith("true", position)) { position += 4; return true; }
    if (input.startsWith("false", position)) { position += 5; return false; }
    if (input.startsWith("null", position)) { position += 4; return null; }
    const match = input.slice(position).match(JSON_NUMBER);
    if (match) { position += match[0].length; return new P12JsonNumber(match[0]); }
    throw new SyntaxError("Invalid JSON value");
  };

  const value = parseValue();
  whitespace();
  if (position !== input.length) throw new SyntaxError("Unexpected trailing JSON data");
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof P12JsonNumber) return value.raw;
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Value cannot be represented as canonical JSON");
}

export function canonicalJsonLines(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return rows.length ? `${rows.map((row) => canonicalJson(row)).join("\n")}\n` : "";
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isP12JsonNumber(value: unknown): value is P12JsonNumber {
  return value instanceof P12JsonNumber;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
