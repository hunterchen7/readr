import { create } from "zustand";
import * as api from "./api";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  serverUrl: string;
  token: string;
  setServerUrl: (url: string) => Promise<void>;
  /** Set auth state directly after email login (token already saved to SecureStore). */
  loginDirect: (token: string) => void;
  signOut: () => Promise<void>;
  /** Called on app launch. Populates state from SecureStore + probes the server. */
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: true,
  serverUrl: "",
  token: "",

  setServerUrl: async (url: string) => {
    const cleaned = url.replace(/\/$/, "");
    await api.setServerUrl(cleaned);
    set({ serverUrl: cleaned });
  },

  loginDirect: (token: string) => {
    set({ token, isAuthenticated: true });
  },

  signOut: async () => {
    await api.clearToken();
    set({ isAuthenticated: false, token: "" });
  },

  checkSession: async () => {
    const serverUrl = (await api.getServerUrl()) ?? "";
    const token = (await api.getToken()) ?? "";
    set({ serverUrl, token });
    if (!serverUrl || !token) {
      set({ isAuthenticated: false, isLoading: false });
      return;
    }
    // Optimistic auth: trust the stored token immediately so the app
    // boots into the library without waiting for the network probe.
    // The probe still runs, but only as a background validity check —
    // if it returns 401/403 we sign out, otherwise (network error,
    // server down) we stay signed in. This is the load-bearing change
    // that makes offline mode work without a "Continue offline" button.
    set({ isAuthenticated: true, isLoading: false });
    void api.checkToken().then((result) => {
      if (result === "invalid") {
        // Server explicitly rejected the token — sign out and clear it.
        void get().signOut();
      }
      // "valid" or "offline" → stay signed in.
    });
  },
}));
