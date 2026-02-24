import IORedis from "ioredis";
import { env } from "./env.js";

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
});
