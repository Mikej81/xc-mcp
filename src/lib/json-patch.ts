/**
 * Minimal JSON-Patch (RFC 6902) implementation supporting add, replace, remove.
 * Paths follow RFC 6901 (e.g. "/spec/routes/0/timeout").
 *
 * Limited on purpose: no move/copy/test ops, no LCS array diffing. Sufficient
 * for XC config-body mutations where arrays are small and authored as wholes.
 */

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

/**
 * Parse an RFC 6901 JSON Pointer into path tokens.
 * "/spec/routes/0" -> ["spec", "routes", "0"]
 * "" -> [] (root)
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: "${pointer}" must start with "/" or be empty`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function buildPointer(tokens: Array<string | number>): string {
  if (tokens.length === 0) return "";
  return "/" + tokens.map((t) => escapeToken(String(t))).join("/");
}

/**
 * Walk to the parent of the target token, returning [parent, lastToken].
 * Throws if any intermediate path segment doesn't exist.
 */
function walkToParent(doc: any, tokens: string[]): { parent: any; key: string } {
  if (tokens.length === 0) {
    throw new Error("Cannot operate on root with no path tokens");
  }

  let cursor = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (cursor == null || typeof cursor !== "object") {
      throw new Error(`Cannot traverse into non-object at "${tokens.slice(0, i).join("/")}"`);
    }
    if (Array.isArray(cursor)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        throw new Error(`Array index out of bounds: "${token}" in path`);
      }
      cursor = cursor[idx];
    } else {
      cursor = cursor[token];
    }
  }

  if (cursor == null || typeof cursor !== "object") {
    throw new Error(`Path target parent is not an object/array`);
  }

  return { parent: cursor, key: tokens[tokens.length - 1] };
}

/**
 * Apply a sequence of JSON-Patch ops to a document and return the mutated copy.
 * The input document is deep-cloned before mutation.
 */
export function applyPatch<T = unknown>(doc: T, ops: JsonPatchOp[]): T {
  const out = JSON.parse(JSON.stringify(doc)) as any;

  for (const op of ops) {
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) {
      if (op.op === "remove") {
        throw new Error(`Cannot remove root document`);
      }
      // add/replace at root
      return (op as any).value;
    }

    const { parent, key } = walkToParent(out, tokens);

    if (Array.isArray(parent)) {
      if (op.op === "remove") {
        const idx = Number(key);
        parent.splice(idx, 1);
      } else if (op.op === "add") {
        if (key === "-") {
          parent.push((op as any).value);
        } else {
          const idx = Number(key);
          if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
            throw new Error(`Invalid array index for add: "${key}"`);
          }
          parent.splice(idx, 0, (op as any).value);
        }
      } else {
        // replace
        const idx = Number(key);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error(`Array index out of bounds for replace: "${key}"`);
        }
        parent[idx] = (op as any).value;
      }
    } else {
      if (op.op === "remove") {
        delete parent[key];
      } else {
        parent[key] = (op as any).value;
      }
    }
  }

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Compute a JSON-Patch that, when applied to `from`, yields `to`.
 *
 * Algorithm: shallow-recursive. For matching keys with object values, recurse.
 * For arrays or scalars that differ, emit a single replace. New keys -> add.
 * Removed keys -> remove. Sufficient for XC config bodies; not LCS-optimal.
 */
export function computeDiff(from: unknown, to: unknown, basePath: Array<string | number> = []): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];

  if (isPlainObject(from) && isPlainObject(to)) {
    const fromKeys = new Set(Object.keys(from));
    const toKeys = new Set(Object.keys(to));

    // Removed keys
    for (const key of fromKeys) {
      if (!toKeys.has(key)) {
        ops.push({ op: "remove", path: buildPointer([...basePath, key]) });
      }
    }
    // Added or changed keys
    for (const key of toKeys) {
      if (!fromKeys.has(key)) {
        ops.push({ op: "add", path: buildPointer([...basePath, key]), value: to[key] });
      } else if (!deepEqual(from[key], to[key])) {
        const fromVal = from[key];
        const toVal = to[key];
        if (isPlainObject(fromVal) && isPlainObject(toVal)) {
          ops.push(...computeDiff(fromVal, toVal, [...basePath, key]));
        } else {
          ops.push({ op: "replace", path: buildPointer([...basePath, key]), value: toVal });
        }
      }
    }
    return ops;
  }

  if (!deepEqual(from, to)) {
    if (basePath.length === 0) {
      ops.push({ op: "replace", path: "", value: to });
    } else {
      ops.push({ op: "replace", path: buildPointer(basePath), value: to });
    }
  }
  return ops;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}
