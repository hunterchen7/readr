/**
 * Last-Write-Wins merge for reading progress.
 * Compares timestamps and picks the newer value.
 */

export interface LWWEntry {
  entityId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface LWWResult {
  accepted: boolean;
  winner: "client" | "server";
}

/**
 * Merge a client progress update against server state.
 * @returns whether the client value should be accepted
 */
export function lwwMerge(
  clientTimestamp: string,
  serverTimestamp: string | null,
): LWWResult {
  if (!serverTimestamp) {
    return { accepted: true, winner: "client" };
  }

  const clientTime = new Date(clientTimestamp).getTime();
  const serverTime = new Date(serverTimestamp).getTime();

  if (clientTime > serverTime) {
    return { accepted: true, winner: "client" };
  }

  // Server wins on tie or if server is newer
  return { accepted: false, winner: "server" };
}
