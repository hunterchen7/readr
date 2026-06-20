import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, gt, lt, sql, desc } from "drizzle-orm";
import { syncPullQuerySchema, syncPushSchema } from "@readr/shared";
import { lwwMerge, setMerge, type ExistingEntity } from "@readr/sync-engine";
import { scopeToUser } from "../middleware/user-scope.js";
import type { SyncLogEntry, SyncConflict, BookPosition } from "@readr/shared";

type Variables = { userId: string };

const syncRouter = new Hono<{ Variables: Variables }>();
type AcceptedEntity = Pick<SyncLogEntry, "entityType" | "entityId">;

// GET /sync/changes?since=<ISO timestamp>&deviceId=<string>
syncRouter.get("/sync/changes", async (c) => {
  const userId = c.get("userId");
  const raw = { since: c.req.query("since"), deviceId: c.req.query("deviceId") };
  const parsed = syncPullQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid query params", details: parsed.error.flatten() }, 400);
  }

  const { since } = parsed.data;
  const sinceDate = new Date(since);

  const changes = await db
    .select()
    .from(schema.syncLog)
    .where(
      and(
        eq(schema.syncLog.userId, userId),
        gt(schema.syncLog.timestamp, sinceDate),
      ),
    )
    .orderBy(schema.syncLog.timestamp);

  const serverTimestamp = new Date().toISOString();

  // Fire-and-forget: prune old sync_log entries so the table doesn't
  // grow without bound. Errors are swallowed — pruning is best-effort.
  pruneSyncLog(userId).catch(() => {});

  return c.json({
    changes: changes.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      operation: row.operation,
      payload: row.payload,
      deviceId: row.deviceId,
      timestamp: row.timestamp.toISOString(),
    })),
    serverTimestamp,
  });
});

// POST /sync/push
syncRouter.post("/sync/push", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = syncPushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { changes } = parsed.data;
  let accepted = 0;
  const acceptedEntities: AcceptedEntity[] = [];
  const conflicts: SyncConflict[] = [];

  for (const change of changes) {
    const entry = change as SyncLogEntry;

    try {
      if (entry.entityType === "progress") {
        const result = await handleProgressSync(userId, entry);
        if (result.accepted) {
          accepted++;
          acceptedEntities.push({
            entityType: entry.entityType,
            entityId: entry.entityId,
          });
        } else {
          conflicts.push({
            entityType: entry.entityType,
            entityId: entry.entityId,
            resolution: "server_wins",
            serverValue: result.serverValue ?? {},
          });
        }
      } else {
        const result = await handleAnnotationSync(userId, entry);
        if (result.accepted) {
          accepted++;
          acceptedEntities.push({
            entityType: entry.entityType,
            entityId: entry.entityId,
          });
        }
      }
    } catch (err) {
      console.error(`Sync error for ${entry.entityType}:${entry.entityId}:`, err);
    }
  }

  return c.json({ accepted, acceptedEntities, conflicts });
});

// ─── Progress sync (LWW) ────────────────────────────────────────────

async function handleProgressSync(
  userId: string,
  entry: SyncLogEntry,
): Promise<{ accepted: boolean; serverValue?: Record<string, unknown> }> {
  const payload = entry.payload as { bookId: string; deviceId: string; position: BookPosition } | null;
  if (!payload) return { accepted: false };

  const existing = await db
    .select()
    .from(schema.readingProgress)
    .where(
      and(
        eq(schema.readingProgress.bookId, payload.bookId),
        eq(schema.readingProgress.userId, userId),
        eq(schema.readingProgress.deviceId, payload.deviceId),
      ),
    )
    .limit(1);

  const serverTimestamp = existing[0]?.updatedAt?.toISOString() ?? null;
  const mergeResult = lwwMerge(entry.timestamp, serverTimestamp);

  if (mergeResult.accepted) {
    if (existing[0]) {
      await db
        .update(schema.readingProgress)
        .set({
          position: payload.position,
          updatedAt: new Date(entry.timestamp),
        })
        .where(eq(schema.readingProgress.id, existing[0].id));
    } else {
      await db.insert(schema.readingProgress).values({
        bookId: payload.bookId,
        userId,
        deviceId: payload.deviceId,
        position: payload.position,
        updatedAt: new Date(entry.timestamp),
      });
    }

    // Log to sync_log
    await db.insert(schema.syncLog).values({
      userId,
      entityType: "progress",
      entityId: existing[0]?.id ?? payload.bookId,
      operation: "update",
      payload: payload as unknown as Record<string, unknown>,
      deviceId: entry.deviceId,
      timestamp: new Date(entry.timestamp),
    });

    return { accepted: true };
  }

  return {
    accepted: false,
    serverValue: existing[0]
      ? { position: existing[0].position, updatedAt: existing[0].updatedAt?.toISOString() }
      : {},
  };
}

// ─── Annotation sync (tombstone set) ────────────────────────────────

async function handleAnnotationSync(
  userId: string,
  entry: SyncLogEntry,
): Promise<{ accepted: boolean }> {
  const { entityType, entityId, operation, payload, timestamp } = entry;

  const existing = await lookupEntity(entityType, entityId, userId);

  const mergeResult = setMerge(
    { operation: operation as "create" | "update" | "delete", entityId, timestamp, payload },
    existing,
  );

  if (mergeResult.action === "skip") {
    if (operation === "delete" && mergeResult.reason === "not_found") {
      await insertTombstoneEntity(entityType, entityId, userId, payload, timestamp);
      await db.insert(schema.syncLog).values({
        userId,
        entityType,
        entityId,
        operation,
        payload,
        deviceId: entry.deviceId,
        timestamp: new Date(timestamp),
      });
      return { accepted: true };
    }
    if (
      mergeResult.reason === "already_exists" ||
      mergeResult.reason === "already_deleted" ||
      mergeResult.reason === "stale_update" ||
      mergeResult.reason === "tombstoned"
    ) {
      return { accepted: true };
    }
    return { accepted: false };
  }

  switch (mergeResult.action) {
    case "insert":
      await insertEntity(entityType, entityId, userId, payload, timestamp);
      break;
    case "update":
      await updateEntity(entityType, entityId, payload, timestamp);
      break;
    case "soft_delete":
      await softDeleteEntity(entityType, entityId, timestamp);
      break;
  }

  await db.insert(schema.syncLog).values({
    userId,
    entityType,
    entityId,
    operation,
    payload,
    deviceId: entry.deviceId,
    timestamp: new Date(timestamp),
  });

  return { accepted: true };
}

async function lookupEntity(
  entityType: string,
  entityId: string,
  userId: string,
): Promise<ExistingEntity | null> {
  switch (entityType) {
    case "bookmark": {
      const rows = await db
        .select({ id: schema.bookmarks.id, deletedAt: schema.bookmarks.deletedAt, createdAt: schema.bookmarks.createdAt })
        .from(schema.bookmarks)
        .where(and(eq(schema.bookmarks.id, entityId), scopeToUser.bookmarks(userId)))
        .limit(1);
      if (!rows[0]) return lookupSyncTombstone(entityType, entityId, userId);
      return { id: rows[0].id, deletedAt: rows[0].deletedAt?.toISOString() ?? null, createdAt: rows[0].createdAt?.toISOString() ?? null };
    }
    case "highlight": {
      const rows = await db
        .select({ id: schema.highlights.id, deletedAt: schema.highlights.deletedAt, createdAt: schema.highlights.createdAt })
        .from(schema.highlights)
        .where(and(eq(schema.highlights.id, entityId), scopeToUser.highlights(userId)))
        .limit(1);
      if (!rows[0]) return lookupSyncTombstone(entityType, entityId, userId);
      return { id: rows[0].id, deletedAt: rows[0].deletedAt?.toISOString() ?? null, createdAt: rows[0].createdAt?.toISOString() ?? null };
    }
    case "note": {
      const rows = await db
        .select({ id: schema.notes.id, deletedAt: schema.notes.deletedAt, updatedAt: schema.notes.updatedAt })
        .from(schema.notes)
        .where(and(eq(schema.notes.id, entityId), scopeToUser.notes(userId)))
        .limit(1);
      if (!rows[0]) return lookupSyncTombstone(entityType, entityId, userId);
      return { id: rows[0].id, deletedAt: rows[0].deletedAt?.toISOString() ?? null, updatedAt: rows[0].updatedAt?.toISOString() ?? null };
    }
    default:
      return null;
  }
}

async function lookupSyncTombstone(
  entityType: string,
  entityId: string,
  userId: string,
): Promise<ExistingEntity | null> {
  const rows = await db
    .select({ timestamp: schema.syncLog.timestamp })
    .from(schema.syncLog)
    .where(
      and(
        eq(schema.syncLog.userId, userId),
        eq(schema.syncLog.entityType, entityType),
        eq(schema.syncLog.entityId, entityId),
        eq(schema.syncLog.operation, "delete"),
      ),
    )
    .orderBy(desc(schema.syncLog.timestamp))
    .limit(1);
  const deletedAt = rows[0]?.timestamp?.toISOString();
  return deletedAt ? { id: entityId, deletedAt } : null;
}

async function insertEntity(
  entityType: string,
  entityId: string,
  userId: string,
  payload: Record<string, unknown> | null,
  timestamp: string,
): Promise<void> {
  if (!payload) return;

  switch (entityType) {
    case "bookmark":
      await db.insert(schema.bookmarks).values({
        id: entityId,
        bookId: payload.bookId as string,
        userId,
        position: payload.position as object,
        label: (payload.label as string) ?? null,
        createdAt: new Date(timestamp),
      });
      break;
    case "highlight":
      await db.insert(schema.highlights).values({
        id: entityId,
        bookId: payload.bookId as string,
        userId,
        cfiRange: payload.cfiRange as string,
        textContent: (payload.textContent as string) ?? null,
        color: (payload.color as string) ?? "yellow",
        chapterLabel: (payload.chapterLabel as string) ?? null,
        percentage: (payload.percentage as number) ?? null,
        createdAt: new Date(timestamp),
      });
      break;
    case "note":
      await db.insert(schema.notes).values({
        id: entityId,
        bookId: payload.bookId as string,
        userId,
        position: payload.position as object,
        noteType: (payload.noteType as string) ?? "typed",
        textContent: (payload.textContent as string) ?? null,
        strokes: (payload.strokes ?? null) as typeof schema.notes.$inferInsert.strokes,
        penConfig: (payload.penConfig ?? null) as typeof schema.notes.$inferInsert.penConfig,
        canvasImage: (payload.canvasImage as string) ?? null,
        createdAt: new Date(timestamp),
        updatedAt: new Date(timestamp),
      });
      break;
  }
}

async function insertTombstoneEntity(
  entityType: string,
  entityId: string,
  userId: string,
  payload: Record<string, unknown> | null,
  timestamp: string,
): Promise<void> {
  if (!payload || typeof payload.bookId !== "string") return;
  const deletedAt = new Date(timestamp);

  switch (entityType) {
    case "bookmark":
      if (!payload.position) return;
      await db.insert(schema.bookmarks).values({
        id: entityId,
        bookId: payload.bookId,
        userId,
        position: payload.position as object,
        label: (payload.label as string) ?? null,
        createdAt: deletedAt,
        deletedAt,
      }).onConflictDoNothing();
      break;
    case "highlight":
      if (typeof payload.cfiRange !== "string") return;
      await db.insert(schema.highlights).values({
        id: entityId,
        bookId: payload.bookId,
        userId,
        cfiRange: payload.cfiRange,
        textContent: (payload.textContent as string) ?? null,
        color: (payload.color as string) ?? "yellow",
        chapterLabel: (payload.chapterLabel as string) ?? null,
        percentage: (payload.percentage as number) ?? null,
        createdAt: deletedAt,
        deletedAt,
      }).onConflictDoNothing();
      break;
    case "note":
      if (!payload.position) return;
      await db.insert(schema.notes).values({
        id: entityId,
        bookId: payload.bookId,
        userId,
        position: payload.position as object,
        noteType: (payload.noteType as string) ?? "typed",
        textContent: (payload.textContent as string) ?? null,
        strokes: (payload.strokes ?? null) as typeof schema.notes.$inferInsert.strokes,
        penConfig: (payload.penConfig ?? null) as typeof schema.notes.$inferInsert.penConfig,
        createdAt: deletedAt,
        updatedAt: deletedAt,
        deletedAt,
      }).onConflictDoNothing();
      break;
  }
}

async function updateEntity(
  entityType: string,
  entityId: string,
  payload: Record<string, unknown> | null,
  timestamp: string,
): Promise<void> {
  if (!payload) return;

  switch (entityType) {
    case "bookmark":
      await db
        .update(schema.bookmarks)
        .set({ label: (payload.label as string) ?? undefined })
        .where(eq(schema.bookmarks.id, entityId));
      break;
    case "highlight":
      await db
        .update(schema.highlights)
        .set({
          note: (payload.note as string) ?? undefined,
          color: (payload.color as string) ?? undefined,
        })
        .where(eq(schema.highlights.id, entityId));
      break;
    case "note":
      await db
        .update(schema.notes)
        .set({
          textContent: (payload.textContent as string) ?? undefined,
          strokes: (payload.strokes as typeof schema.notes.$inferInsert.strokes) ?? undefined,
          penConfig: (payload.penConfig as typeof schema.notes.$inferInsert.penConfig) ?? undefined,
          canvasImage: Object.prototype.hasOwnProperty.call(payload, "canvasImage")
            ? (payload.canvasImage as string | null)
            : undefined,
          updatedAt: new Date(timestamp),
        })
        .where(eq(schema.notes.id, entityId));
      break;
  }
}

async function softDeleteEntity(
  entityType: string,
  entityId: string,
  timestamp: string,
): Promise<void> {
  const deletedAt = new Date(timestamp);

  switch (entityType) {
    case "bookmark":
      await db.update(schema.bookmarks).set({ deletedAt }).where(eq(schema.bookmarks.id, entityId));
      break;
    case "highlight":
      await db.update(schema.highlights).set({ deletedAt }).where(eq(schema.highlights.id, entityId));
      break;
    case "note":
      await db.update(schema.notes).set({ deletedAt }).where(eq(schema.notes.id, entityId));
      break;
  }
}

// ─── Sync log maintenance ──────────────────────────────────────────
//
// The sync_log table is append-only and grows without bound. We prune
// entries older than 90 days on every pull. This is safe because any
// client that hasn't synced in 90 days will get a full re-sync on next
// connect (the server returns all current entity state, not just the
// delta). The 90-day window is generous — most clients sync daily.

const SYNC_LOG_RETENTION_DAYS = 90;

async function pruneSyncLog(userId: string): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SYNC_LOG_RETENTION_DAYS);

  await db
    .delete(schema.syncLog)
    .where(
      and(
        eq(schema.syncLog.userId, userId),
        lt(schema.syncLog.timestamp, cutoff),
      ),
    );
}

export default syncRouter;
