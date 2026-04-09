import { create } from "zustand";
import * as api from "./api";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  serverUrl: string;
  token: string;
  setServerUrl: (url: string) => Promise<void>;
  /** Store a token (existing or freshly generated) and register it server-side. */
  saveToken: (token: string) => Promise<void>;
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

  saveToken: async (token: string) => {
    const { serverUrl } = get();
    if (!serverUrl) throw new Error("Set the server URL first");
    if (token.length < 16) throw new Error("Token must be at least 16 characters");
    // Register server-side (idempotent). Sets the user row if missing.
    await api.registerToken(serverUrl, token);
    await api.setToken(token);
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
    const ok = await api.checkToken();
    set({ isAuthenticated: ok, isLoading: false });
  },
}));
