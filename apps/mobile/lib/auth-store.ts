import { create } from "zustand";
import * as api from "./api";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  serverUrl: string;
  setServerUrl: (url: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  isLoading: true,
  serverUrl: "",

  setServerUrl: async (url: string) => {
    await api.setServerUrl(url.replace(/\/$/, ""));
    set({ serverUrl: url });
  },

  signIn: async (email: string, password: string) => {
    await api.signIn(email, password);
    set({ isAuthenticated: true });
  },

  signUp: async (email: string, password: string, name: string) => {
    await api.signUp(email, password, name);
    set({ isAuthenticated: true });
  },

  signOut: async () => {
    await api.signOut();
    set({ isAuthenticated: false });
  },

  checkSession: async () => {
    try {
      const serverUrl = await api.getServerUrl();
      if (!serverUrl) {
        set({ isAuthenticated: false, isLoading: false, serverUrl: "" });
        return;
      }
      set({ serverUrl });
      await api.getSession();
      set({ isAuthenticated: true, isLoading: false });
    } catch {
      set({ isAuthenticated: false, isLoading: false });
    }
  },
}));
