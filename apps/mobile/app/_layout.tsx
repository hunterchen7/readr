import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { useAuthStore } from "../lib/auth-store";
import { DisplayProvider, useDisplayStore } from "../contexts/DisplayContext";
import { useSyncStatus } from "../lib/sync-status";
import { useLibraryPrefs } from "../lib/library-prefs";
import { initDeviceId } from "../lib/local-db";
import { initNetworkStatus } from "../lib/network-status";

// One-time reset to fix devices stuck past the annotation sync_log
// cutoff. The legacy-id bug caused pushes to 400, but progress kept
// advancing `lastSyncTimestamp` on successful pulls, so by the time
// the fix shipped every device had `since` well past the real
// annotation timestamps (which server-side store at client-creation
// time, not server-receive time). Clearing the timestamp forces the
// next pull to fetch the whole sync_log from epoch and apply every
// annotation the device missed.
const RESYNC_FLAG = "forceResync_v1";
async function runOneShotResync(): Promise<void> {
  try {
    const already = await SecureStore.getItemAsync(RESYNC_FLAG);
    if (already) return;
    await SecureStore.deleteItemAsync("lastSyncTimestamp");
    await SecureStore.setItemAsync(RESYNC_FLAG, "done");
  } catch {
    // Non-fatal: if SecureStore is unhappy, sync still works normally.
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

export default function RootLayout() {
  const checkSession = useAuthStore((s) => s.checkSession);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const hydrateLibraryPrefs = useLibraryPrefs((s) => s.hydrate);
  useEffect(() => {
    (async () => {
      // Must run before the sync effect — otherwise the pre-fix
      // lastSyncTimestamp is still in place when runSync fires.
      await runOneShotResync();
      initDeviceId().catch(() => {});
      // Subscribe to NetInfo so the offline indicator updates and
      // the sync queue auto-drains on reconnect.
      initNetworkStatus();
      checkSession();
      hydrateLibraryPrefs();
    })();
  }, [checkSession, hydrateLibraryPrefs]);

  // Run sync on app open when authenticated (routes through the sync-status
  // store so the library header chip reflects the result).
  const runSyncNow = useSyncStatus((s) => s.sync);
  useEffect(() => {
    if (isAuthenticated) {
      runSyncNow().catch(() => {
        // Sync failure is non-fatal — offline mode still works
      });
    }
  }, [isAuthenticated, runSyncNow]);

  const isEink = useDisplayStore((s) => s.settings.isEink);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <DisplayProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="reader/[bookId]"
              options={{
                headerShown: false,
                animation: isEink ? "none" : "slide_from_right",
              }}
            />
          </Stack>
          {/* On e-ink, force dark glyphs so status-bar icons stay readable
              against the reader/library page. We deliberately don't touch
              translucent or backgroundColor: the app runs edge-to-edge and
              every screen already pads by `insets.top`, so a solid bar
              would double-count the top inset and also cover sepia/dark
              reader themes with a white strip. */}
          <StatusBar style={isEink ? "dark" : "auto"} />
        </DisplayProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
