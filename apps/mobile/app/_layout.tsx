import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "../lib/auth-store";
import { DisplayProvider, useDisplayStore } from "../contexts/DisplayContext";
import { runSync } from "../lib/sync";

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

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Run sync on app open when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      runSync().catch(() => {
        // Sync failure is non-fatal — offline mode still works
      });
    }
  }, [isAuthenticated]);

  const isEink = useDisplayStore((s) => s.settings.isEink);

  return (
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
        <StatusBar style="auto" />
      </DisplayProvider>
    </QueryClientProvider>
  );
}
