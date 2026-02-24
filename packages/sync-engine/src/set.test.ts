import { describe, it, expect } from "vitest";
import { setMerge, processBatch, type ExistingEntity } from "./set.js";

describe("setMerge", () => {
  describe("create", () => {
    it("inserts when entity does not exist", () => {
      const result = setMerge(
        { operation: "create", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: {} },
        null,
      );
      expect(result).toEqual({ action: "insert" });
    });

    it("skips when entity already exists", () => {
      const result = setMerge(
        { operation: "create", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: {} },
        { id: "1", deletedAt: null },
      );
      expect(result).toEqual({ action: "skip", reason: "already_exists" });
    });

    it("skips when entity is tombstoned (tombstone wins)", () => {
      const result = setMerge(
        { operation: "create", entityId: "1", timestamp: "2024-01-02T00:00:00Z", payload: {} },
        { id: "1", deletedAt: "2024-01-01T00:00:00Z" },
      );
      expect(result).toEqual({ action: "skip", reason: "tombstoned" });
    });
  });

  describe("update", () => {
    it("updates when entity exists and change is newer", () => {
      const result = setMerge(
        { operation: "update", entityId: "1", timestamp: "2024-01-02T00:00:00Z", payload: {} },
        { id: "1", deletedAt: null, updatedAt: "2024-01-01T00:00:00Z" },
      );
      expect(result).toEqual({ action: "update" });
    });

    it("skips stale update", () => {
      const result = setMerge(
        { operation: "update", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: {} },
        { id: "1", deletedAt: null, updatedAt: "2024-01-02T00:00:00Z" },
      );
      expect(result).toEqual({ action: "skip", reason: "stale_update" });
    });

    it("inserts if entity does not exist (treat as create)", () => {
      const result = setMerge(
        { operation: "update", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: {} },
        null,
      );
      expect(result).toEqual({ action: "insert" });
    });

    it("skips update on tombstoned entity", () => {
      const result = setMerge(
        { operation: "update", entityId: "1", timestamp: "2024-01-02T00:00:00Z", payload: {} },
        { id: "1", deletedAt: "2024-01-01T00:00:00Z" },
      );
      expect(result).toEqual({ action: "skip", reason: "tombstoned" });
    });
  });

  describe("delete", () => {
    it("soft deletes existing entity", () => {
      const result = setMerge(
        { operation: "delete", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: null },
        { id: "1", deletedAt: null },
      );
      expect(result).toEqual({ action: "soft_delete" });
    });

    it("skips delete when entity does not exist", () => {
      const result = setMerge(
        { operation: "delete", entityId: "1", timestamp: "2024-01-01T00:00:00Z", payload: null },
        null,
      );
      expect(result).toEqual({ action: "skip", reason: "not_found" });
    });

    it("skips delete when already tombstoned", () => {
      const result = setMerge(
        { operation: "delete", entityId: "1", timestamp: "2024-01-02T00:00:00Z", payload: null },
        { id: "1", deletedAt: "2024-01-01T00:00:00Z" },
      );
      expect(result).toEqual({ action: "skip", reason: "already_deleted" });
    });
  });
});

describe("processBatch", () => {
  it("processes multiple changes against existing map", () => {
    const changes = [
      { operation: "create" as const, entityId: "a", timestamp: "2024-01-01T00:00:00Z", payload: {} },
      { operation: "delete" as const, entityId: "b", timestamp: "2024-01-01T00:00:00Z", payload: null },
      { operation: "update" as const, entityId: "c", timestamp: "2024-01-02T00:00:00Z", payload: {} },
    ];

    const existing = new Map<string, ExistingEntity | null>([
      ["a", null],
      ["b", { id: "b", deletedAt: null }],
      ["c", { id: "c", deletedAt: null, updatedAt: "2024-01-01T00:00:00Z" }],
    ]);

    const results = processBatch(changes, existing);
    expect(results).toHaveLength(3);
    expect(results[0].result.action).toBe("insert");
    expect(results[1].result.action).toBe("soft_delete");
    expect(results[2].result.action).toBe("update");
  });
});
