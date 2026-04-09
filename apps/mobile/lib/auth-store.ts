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
    const ok = await api.checkToken();
    set({ isAuthenticated: ok, isLoading: false });
  },
}));
