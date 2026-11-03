// Minimal JSON Schema validator — enough for the stage contracts we use
// (FR-7.1: JSON schema check). Covers type, required, properties, items, enum
// and numeric/length bounds.

export interface SchemaIssue {
  path: string;
  message: string;
}

export function validateSchema(schema: any, value: any, path = "$"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!schema || typeof schema !== "object") return issues;

  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  const type = schema.type;
  if (type) {
    const actual = jsonType(value);
    const types = Array.isArray(type) ? type : [type];
    const ok = types.some((t: string) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(value)));
    if (!ok) {
      issues.push({ path, message: `expected ${types.join("|")}, got ${actual}` });
      return issues;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      issues.push({ path, message: `shorter than minLength ${schema.minLength}` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issues.push({ path, message: `longer than maxLength ${schema.maxLength}` });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      issues.push({ path, message: `below minimum ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum)
      issues.push({ path, message: `above maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      issues.push({ path, message: `needs at least ${schema.minItems} items` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      issues.push({ path, message: `allows at most ${schema.maxItems} items` });
    if (schema.items) {
      value.forEach((v, i) => issues.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const req of schema.required ?? []) {
      if (value[req] == null) issues.push({ path: `${path}.${req}`, message: "is required" });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) {
        issues.push(...validateSchema(sub, value[key], `${path}.${key}`));
      }
    }
  }

  return issues;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function issuesToText(issues: SchemaIssue[]): string {
  return issues.slice(0, 12).map((i) => `${i.path}: ${i.message}`).join("; ");
}
