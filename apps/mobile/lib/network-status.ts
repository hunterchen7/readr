import { create } from "zustand";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useSyncStatus } from "./sync-status";

/**
 * Single source of truth for "is the device online?". NetInfo's
 * isInternetReachable returns null until the first probe completes,
 * which we treat as "assume online" so the app doesn't render an
 * offline badge during boot. After the first event we trust whatever
 * NetInfo says.
 *
 * On the offline → online transition we kick a runSync() automatically
 * so the local sync queue drains as soon as the network comes back,
 * without the user having to tap the chip.
 */
interface NetworkState {
  /** True iff NetInfo reports a connected, internet-reachable network. */
  isOnline: boolean;
  /** True until the first NetInfo event lands; suppresses the offline badge during boot. */
  isHydrated: boolean;
  setFromNetInfo: (state: NetInfoState) => void;
}

export const useNetworkStatus = create<NetworkState>((set, get) => ({
  isOnline: true,
  isHydrated: false,
  setFromNetInfo: (state: NetInfoState) => {
    // isInternetReachable is the strictest signal — true means a reach
    // probe succeeded, false means it failed, null means unknown.
    // Treat null and undefined as "assume online" so we never render an
    // offline state on a half-initialised reading.
    const reachable =
      state.isInternetReachable === null || state.isInternetReachable === undefined
        ? state.isConnected ?? true
        : state.isInternetReachable;
    const wasOnline = get().isOnline;
    const nowOnline = !!state.isConnected && reachable;
    set({ isOnline: nowOnline, isHydrated: true });

    // Reconnect: drain the sync queue. Fire-and-forget — the sync
    // store handles its own running/error state and the queue stays
    // intact on failure so we'll just retry on the next reconnect.
    if (!wasOnline && nowOnline) {
      void useSyncStatus.getState().sync();
    }
  },
}));

let _unsubscribe: (() => void) | null = null;

/** Call once on app boot to start receiving NetInfo events. */
export function initNetworkStatus(): void {
  if (_unsubscribe) return;
  _unsubscribe = NetInfo.addEventListener((state) => {
    useNetworkStatus.getState().setFromNetInfo(state);
  });
  // Kick a one-shot fetch so we don't wait for the first transition
  // to learn whether we're online.
  void NetInfo.fetch().then((state) => {
    useNetworkStatus.getState().setFromNetInfo(state);
  });
}
