import { readFileSync } from "node:fs";
import type { DiscoverParams, OperationIndexEntry, OperationsIndex } from "../types/index.js";

let cachedIndex: OperationsIndex | null = null;

export function loadIndex(indexPath: string): OperationsIndex {
  if (cachedIndex) return cachedIndex;
  const raw = readFileSync(indexPath, "utf-8");
  cachedIndex = JSON.parse(raw) as OperationsIndex;
  return cachedIndex;
}

export function searchOperations(
  index: OperationsIndex,
  params: DiscoverParams,
): { results: OperationIndexEntry[]; total: number } {
  let results = index.operations;

  // Filter by category
  if (params.category) {
    const cat = params.category.toLowerCase();
    results = results.filter((op) => op.category.toLowerCase() === cat);
  }

  // Filter by method
  if (params.method) {
    const method = params.method.toUpperCase();
    results = results.filter((op) => op.method === method);
  }

  // Filter by resource type
  if (params.resource_type) {
    const rt = params.resource_type.toLowerCase();
    results = results.filter((op) => op.resourceType.toLowerCase().includes(rt));
  }

  // Text search across summary, description, path, operationId
  if (params.query) {
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    results = results.filter((op) => {
      const searchable = `${op.summary} ${op.description} ${op.path} ${op.operationId} ${op.resourceType} ${op.tags.join(" ")}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  const total = results.length;
  const offset = params.offset || 0;
  const limit = Math.min(params.limit || 20, 50);

  return {
    results: results.slice(offset, offset + limit),
    total,
  };
}

export function findOperation(
  index: OperationsIndex,
  key: string,
): OperationIndexEntry | undefined {
  return index.operations.find((op) => op.key === key);
}

export function getCategories(index: OperationsIndex): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const op of index.operations) {
    counts.set(op.category, (counts.get(op.category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
