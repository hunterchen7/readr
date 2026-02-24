import { describe, it, expect } from "vitest";
import { lwwMerge } from "./lww.js";

describe("lwwMerge", () => {
  it("accepts client when no server state exists", () => {
    const result = lwwMerge("2024-01-01T12:00:00Z", null);
    expect(result).toEqual({ accepted: true, winner: "client" });
  });

  it("accepts client when client timestamp is newer", () => {
    const result = lwwMerge("2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z");
    expect(result).toEqual({ accepted: true, winner: "client" });
  });

  it("rejects client when server timestamp is newer", () => {
    const result = lwwMerge("2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z");
    expect(result).toEqual({ accepted: false, winner: "server" });
  });

  it("server wins on tie", () => {
    const ts = "2024-01-01T12:00:00Z";
    const result = lwwMerge(ts, ts);
    expect(result).toEqual({ accepted: false, winner: "server" });
  });

  it("handles millisecond differences", () => {
    const result = lwwMerge(
      "2024-01-01T12:00:00.001Z",
      "2024-01-01T12:00:00.000Z",
    );
    expect(result).toEqual({ accepted: true, winner: "client" });
  });
});
