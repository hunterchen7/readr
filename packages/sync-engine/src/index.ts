export { lwwMerge, type LWWEntry, type LWWResult } from "./lww";
export {
  setMerge,
  processBatch,
  type SetOperation,
  type SetMergeInput,
  type ExistingEntity,
  type SetMergeResult,
} from "./set";
export { deduplicateQueue, partitionByType, type QueuedChange } from "./queue";
