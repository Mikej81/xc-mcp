import { describe, it, expect } from "vitest";
import { substitutePath } from "../lib/api-client.js";

describe("substitutePath", () => {
  it("returns template unchanged when no params provided", () => {
    expect(substitutePath("/api/config/namespaces", {})).toBe(
      "/api/config/namespaces",
    );
  });

  it("substitutes a single param", () => {
    expect(
      substitutePath("/api/config/namespaces/{namespace}", {
        namespace: "default",
      }),
    ).toBe("/api/config/namespaces/default");
  });

  it("substitutes multiple params", () => {
    expect(
      substitutePath(
        "/api/config/namespaces/{namespace}/http_loadbalancers/{name}",
        { namespace: "default", name: "my-lb" },
      ),
    ).toBe("/api/config/namespaces/default/http_loadbalancers/my-lb");
  });

  it("encodes URL-special characters", () => {
    expect(
      substitutePath("/api/{id}", { id: "hello world/foo?bar=baz" }),
    ).toBe("/api/hello%20world%2Ffoo%3Fbar%3Dbaz");
  });

  it("handles dot-notation keys like {metadata.name}", () => {
    expect(
      substitutePath("/api/{metadata.name}/details", {
        "metadata.name": "my-resource",
      }),
    ).toBe("/api/my-resource/details");
  });

  it("leaves unmatched tokens as-is", () => {
    expect(
      substitutePath("/api/{namespace}/{name}", { namespace: "default" }),
    ).toBe("/api/default/{name}");
  });

  it("handles empty pathParams object", () => {
    expect(substitutePath("/api/{namespace}", {})).toBe("/api/{namespace}");
  });

  it("replaces all occurrences of the same token", () => {
    expect(
      substitutePath("/api/{ns}/a/{ns}/b", { ns: "x" }),
    ).toBe("/api/x/a/x/b");
  });
});
