import { Hono } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, gte, sql, desc } from "drizzle-orm";

type Variables = { userId: string };

const statsRouter = new Hono<{ Variables: Variables }>();

// POST /stats/sessions — log a reading session
statsRouter.post("/stats/sessions", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json() as {
    bookId: string;
    startedAt: string;
    endedAt: string;
    durationMinutes: number;
    pagesRead?: number;
    startPercentage?: number;
    endPercentage?: number;
  };

  const [session] = await db
    .insert(schema.readingSessions)
    .values({
      userId,
      bookId: body.bookId,
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
    .where(eq(schema.readingSessions.userId, userId));

  // Total books
  const [booksResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.books)
    .where(eq(schema.books.userId, userId));

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
        eq(schema.readingSessions.userId, userId),
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
        eq(schema.readingSessions.userId, userId),
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
        eq(schema.readingSessions.userId, userId),
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
