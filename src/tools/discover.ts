import type { OperationsIndex, DiscoverParams } from "../types/index.js";
import { searchOperations, getCategories } from "../lib/spec-index.js";

export function handleDiscover(
  index: OperationsIndex,
  params: DiscoverParams,
): { content: Array<{ type: "text"; text: string }> } {
  // If no params at all, return category listing
  if (!params.query && !params.category && !params.method && !params.resource_type) {
    const categories = getCategories(index);
    const lines = [
      `F5 XC API -- ${index.totalOperations} operations across ${categories.length} categories:\n`,
      ...categories.map((c) => `  ${c.name}: ${c.count} operations`),
      `\nUse query, category, method, or resource_type to search.`,
      `Example: { "query": "load balancer", "method": "GET" }`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const { results, total } = searchOperations(index, params);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No operations found matching your criteria. Try broadening your search.",
        },
      ],
    };
  }

  const offset = params.offset || 0;
  const lines = [
    `Found ${total} operations (showing ${offset + 1}-${offset + results.length}):\n`,
  ];

  for (const op of results) {
    const parts = [op.key, op.summary || "(no summary)", op.category];
    if (op.pathParams.length > 0) parts.push(`params: ${op.pathParams.join(",")}`);
    if (op.hasRequestBody) parts.push("has body");
    lines.push(`- ${parts.join(" | ")}`);
  }
  lines.push("");

  if (total > offset + results.length) {
    lines.push(
      `\n... ${total - offset - results.length} more results. Use offset: ${offset + results.length} to see next page.`,
    );
  }

  lines.push(
    `\nUse xc_get_operation_details with operation_key (e.g., "${results[0].key}") to get full schema.`,
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
