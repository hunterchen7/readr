import { describe, it, expect } from "vitest";
import { deduplicateQueue, partitionByType } from "./queue.js";
import type { SyncLogEntry } from "@readr/shared";

describe("deduplicateQueue", () => {
  it("keeps only the latest change per entity", () => {
    const entries: SyncLogEntry[] = [
      {
        entityType: "progress",
        entityId: "p1",
        operation: "update",
        payload: { percentage: 10 },
        deviceId: "d1",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        entityType: "progress",
        entityId: "p1",
        operation: "update",
        payload: { percentage: 50 },
        deviceId: "d1",
        timestamp: "2024-01-01T01:00:00Z",
      },
      {
        entityType: "bookmark",
        entityId: "b1",
        operation: "create",
        payload: {},
        deviceId: "d1",
        timestamp: "2024-01-01T00:30:00Z",
      },
    ];

    const result = deduplicateQueue(entries);
    expect(result).toHaveLength(2);

    const progress = result.find((e) => e.entityType === "progress");
    expect(progress?.payload).toEqual({ percentage: 50 });
  });

  it("returns empty for empty input", () => {
    expect(deduplicateQueue([])).toEqual([]);
  });

  it("keeps different entities separate", () => {
    const entries: SyncLogEntry[] = [
      {
        entityType: "bookmark",
        entityId: "b1",
        operation: "create",
        payload: null,
        deviceId: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        entityType: "bookmark",
        entityId: "b2",
        operation: "create",
        payload: null,
        deviceId: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];
    expect(deduplicateQueue(entries)).toHaveLength(2);
  });
});

describe("partitionByType", () => {
  it("groups entries by entity type", () => {
    const entries: SyncLogEntry[] = [
      {
        entityType: "progress",
        entityId: "p1",
        operation: "update",
        payload: null,
        deviceId: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        entityType: "bookmark",
        entityId: "b1",
        operation: "create",
        payload: null,
        deviceId: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        entityType: "progress",
        entityId: "p2",
        operation: "update",
        payload: null,
        deviceId: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const partitions = partitionByType(entries);
    expect(partitions["progress"]).toHaveLength(2);
    expect(partitions["bookmark"]).toHaveLength(1);
  });
});
