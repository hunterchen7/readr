export { lwwMerge, type LWWEntry, type LWWResult } from "./lww.js";
export {
  setMerge,
  processBatch,
  type SetOperation,
  type SetMergeInput,
  type ExistingEntity,
  type SetMergeResult,
} from "./set.js";
export { deduplicateQueue, partitionByType, type QueuedChange } from "./queue.js";
