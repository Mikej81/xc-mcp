import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { categorize } from "../src/lib/categories.js";
import type { OperationIndexEntry, OperationsIndex } from "../src/types/index.js";

const SPECS_DIR = join(import.meta.dirname, "..", "f5-api");
const OUTPUT_DIR = join(import.meta.dirname, "..", "data");
const OUTPUT_FILE = join(OUTPUT_DIR, "operations-index.json");

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;

function extractPathParams(path: string): string[] {
  const matches = path.match(/\{([^}]+)\}/g);
  return matches ? matches.map((m) => m.slice(1, -1)) : [];
}

function extractResourceType(path: string): string {
  // Extract the main resource type from the path
  // e.g., /api/config/namespaces/{namespace}/http_loadbalancers -> http_loadbalancers
  const parts = path.split("/").filter(Boolean);
  // Find the last non-parameter segment
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].startsWith("{")) {
      return parts[i];
    }
  }
  return "";
}

function buildIndex(): void {
  console.log(`Reading specs from: ${SPECS_DIR}`);

  const specFiles = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Found ${specFiles.length} spec files`);

  const operations: OperationIndexEntry[] = [];
  const seenKeys = new Set<string>();

  for (const specFile of specFiles) {
    const filePath = join(SPECS_DIR, specFile);
    let spec: any;

    try {
      spec = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (e) {
      console.warn(`  Skipping ${specFile}: failed to parse JSON`);
      continue;
    }

    const paths = spec.paths || {};

    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;

      for (const method of HTTP_METHODS) {
        const operation = (pathItem as any)[method];
        if (!operation) continue;

        const key = `${method.toUpperCase()}:${path}`;

        // Handle duplicate keys by appending spec file context
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);

        const queryParams: string[] = [];
        const pathParams = extractPathParams(path);

        if (Array.isArray(operation.parameters)) {
          for (const param of operation.parameters) {
            if (param.in === "query") {
              queryParams.push(param.name);
            }
          }
        }

        // Also check path-level parameters
        if (Array.isArray((pathItem as any).parameters)) {
          for (const param of (pathItem as any).parameters) {
            if (param.in === "query") {
              queryParams.push(param.name);
            }
          }
        }

        const hasRequestBody = !!(operation.requestBody);

        const operationId = operation.operationId || "";
        const summary = operation.summary || "";
        const description = (operation.description || "").slice(0, 300);
        const tags = operation.tags || [];

        const category = categorize(path, operationId, specFile);
        const resourceType = extractResourceType(path);

        operations.push({
          key,
          method: method.toUpperCase(),
          path,
          summary,
          description,
          operationId,
          category,
          tags,
          pathParams,
          queryParams,
          hasRequestBody,
          specFile,
          resourceType,
        });
      }
    }
  }

  // Sort by category then path
  operations.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.path.localeCompare(b.path);
  });

  const categories = [...new Set(operations.map((o) => o.category))].sort();

  const index: OperationsIndex = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    totalOperations: operations.length,
    categories,
    operations,
  };

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2));

  console.log(`\nIndex built successfully:`);
  console.log(`  Total operations: ${operations.length}`);
  console.log(`  Categories: ${categories.length}`);
  console.log(`  Output: ${OUTPUT_FILE}`);
  console.log(`  Size: ${(readFileSync(OUTPUT_FILE).length / 1024).toFixed(1)} KB`);
  console.log(`\nOperations per category:`);
  for (const cat of categories) {
    const count = operations.filter((o) => o.category === cat).length;
    console.log(`  ${cat}: ${count}`);
  }
}

buildIndex();
