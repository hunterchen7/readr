import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { scopeToUser } from "../middleware/user-scope.js";
import { badRequest, forbidden } from "../lib/errors.js";

type Variables = { userId: string };

const sessionSchema = z.object({
  bookId: z.string().uuid(),
  deviceId: z.string().max(128).nullish(),
  startedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  endedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  durationMinutes: z.number().int().min(0).max(1440),
  pagesRead: z.number().int().min(0).nullish(),
  startPercentage: z.number().int().min(0).max(100).nullish(),
  endPercentage: z.number().int().min(0).max(100).nullish(),
});

const statsRouter = new Hono<{ Variables: Variables }>();

/** Verify the authenticated user owns the book, or throw 403. */
async function assertBookOwnership(bookId: string, userId: string) {
  const [row] = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), scopeToUser.books(userId)));
  if (!row) throw forbidden("Book does not belong to user");
}

// POST /stats/sessions — log a reading session
statsRouter.post("/stats/sessions", async (c) => {
  const userId = c.get("userId");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid session data");
  const body = parsed.data;
  await assertBookOwnership(body.bookId, userId);

  const [session] = await db
    .insert(schema.readingSessions)
    .values({
      userId,
      bookId: body.bookId,
      deviceId: body.deviceId ?? null,
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
      durationMinutes: body.durationMinutes,
      pagesRead: body.pagesRead ?? null,
      startPercentage: body.startPercentage ?? null,
      endPercentage: body.endPercentage ?? null,
    })
    .returning();

  return c.json({ session }, 201);
});

// GET /stats/summary — reading stats summary
statsRouter.get("/stats/summary", async (c) => {
  const userId = c.get("userId");

  // Total reading time
  const [totalResult] = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${schema.readingSessions.durationMinutes}), 0)`,
      sessionCount: sql<number>`COUNT(*)`,
    })
    .from(schema.readingSessions)
    .where(scopeToUser.readingSessions(userId));

  // Total books
  const [booksResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.books)
    .where(scopeToUser.books(userId));

  // Reading streak (consecutive days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentSessions = await db
    .select({
      date: sql<string>`DATE(${schema.readingSessions.startedAt})`,
    })
    .from(schema.readingSessions)
    .where(
      and(
        scopeToUser.readingSessions(userId),
        gte(schema.readingSessions.startedAt, thirtyDaysAgo),
      ),
    )
    .groupBy(sql`DATE(${schema.readingSessions.startedAt})`)
    .orderBy(desc(sql`DATE(${schema.readingSessions.startedAt})`));

  // Calculate streak
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < recentSessions.length; i++) {
    const sessionDate = new Date(recentSessions[i].date);
    sessionDate.setHours(0, 0, 0, 0);

    const expectedDate = new Date(today);
    expectedDate.setDate(expectedDate.getDate() - i);

    if (sessionDate.getTime() === expectedDate.getTime()) {
      streak++;
    } else {
      break;
    }
  }

  // This week's reading time
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const [weekResult] = await db
    .select({
      minutes: sql<number>`COALESCE(SUM(${schema.readingSessions.durationMinutes}), 0)`,
    })
    .from(schema.readingSessions)
    .where(
      and(
        scopeToUser.readingSessions(userId),
        gte(schema.readingSessions.startedAt, weekStart),
      ),
    );

  return c.json({
    totalBooks: Number(booksResult.count),
    totalReadingMinutes: Number(totalResult.totalMinutes),
    totalSessions: Number(totalResult.sessionCount),
    currentStreak: streak,
    weeklyMinutes: Number(weekResult.minutes),
  });
});

// GET /stats/daily — daily reading minutes for the last 30 days
statsRouter.get("/stats/daily", async (c) => {
  const userId = c.get("userId");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const daily = await db
    .select({
      date: sql<string>`DATE(${schema.readingSessions.startedAt})`,
      minutes: sql<number>`COALESCE(SUM(${schema.readingSessions.durationMinutes}), 0)`,
    })
    .from(schema.readingSessions)
    .where(
      and(
        scopeToUser.readingSessions(userId),
        gte(schema.readingSessions.startedAt, thirtyDaysAgo),
      ),
    )
    .groupBy(sql`DATE(${schema.readingSessions.startedAt})`)
    .orderBy(sql`DATE(${schema.readingSessions.startedAt})`);

  return c.json({
    daily: daily.map((d) => ({
      date: d.date,
      minutes: Number(d.minutes),
    })),
  });
});

export default statsRouter;
