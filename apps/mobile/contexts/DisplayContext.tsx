import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Platform, NativeModules } from "react-native";
import { create } from "zustand";
import { getItem, setItem } from "../lib/storage";

export interface DisplaySettings {
  isEink: boolean;
  animationsEnabled: boolean;
  highContrast: boolean;
  minTapTarget: number;
  scrollMode: "smooth" | "paginated";
  refreshMode: "normal" | "a2";
}

const DEFAULT_SETTINGS: DisplaySettings = {
  isEink: false,
  animationsEnabled: true,
  highContrast: false,
  minTapTarget: 48,
  scrollMode: "smooth",
  refreshMode: "normal",
};

const EINK_SETTINGS: DisplaySettings = {
  isEink: true,
  animationsEnabled: false,
  highContrast: true,
  minTapTarget: 64,
  scrollMode: "paginated",
  refreshMode: "a2",
};

// Persistence: stored as the literal string "1" / "0" under this key.
// `null` (key absent) means "no user override yet — defer to detection".
const STORAGE_KEY = "readr.display.einkOverride";

interface DisplayStore {
  settings: DisplaySettings;
  // null = user has never picked, defer to auto-detect.
  // boolean = explicit user choice, wins over detection forever.
  userOverride: boolean | null;
  // False until storage has been read on launch. Detection effect waits
  // for this so it doesn't clobber a stored override during the gap
  // between mount and async storage resolving.
  hydrated: boolean;
  setIsEink: (isEink: boolean) => void;
  toggleEink: () => void;
  hydrate: (override: boolean | null) => void;
  applyDetection: (detectedEink: boolean) => void;
}

export const useDisplayStore = create<DisplayStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  userOverride: null,
  hydrated: false,
  setIsEink: (isEink: boolean) => {
    set({
      settings: isEink ? EINK_SETTINGS : DEFAULT_SETTINGS,
      userOverride: isEink,
    });
    void setItem(STORAGE_KEY, isEink ? "1" : "0");
  },
  toggleEink: () =>
    set((state) => {
      const next = !state.settings.isEink;
      void setItem(STORAGE_KEY, next ? "1" : "0");
      return {
        settings: next ? EINK_SETTINGS : DEFAULT_SETTINGS,
        userOverride: next,
      };
    }),
  // Hydrate from storage; only applies override if one was stored.
  // The auto-detection effect then runs only when override is null.
  hydrate: (override) =>
    set({
      hydrated: true,
      userOverride: override,
      settings: override === true
        ? EINK_SETTINGS
        : override === false
          ? DEFAULT_SETTINGS
          : DEFAULT_SETTINGS,
    }),
  // Auto-detection result. Skipped when a user override exists.
  applyDetection: (detectedEink) =>
    set((state) =>
      state.userOverride !== null
        ? state
        : { settings: detectedEink ? EINK_SETTINGS : DEFAULT_SETTINGS },
    ),
}));

/** Detect if running on a Supernote e-ink device */
function detectEinkDevice(): boolean {
  if (Platform.OS !== "android") return false;

  try {
    const constants =
      NativeModules.PlatformConstants ?? (Platform as unknown as { constants?: Record<string, string> }).constants;

    if (!constants) return false;

    const brand = (constants.Brand ?? constants.brand ?? "").toLowerCase();
    const model = (constants.Model ?? constants.model ?? "").toLowerCase();
    const manufacturer = (constants.Manufacturer ?? constants.manufacturer ?? "").toLowerCase();

    // Supernote is made by Ratta
    if (manufacturer.includes("ratta") || brand.includes("ratta")) return true;
    if (model.includes("supernote")) return true;

    // Other common e-ink brands
    if (brand.includes("onyx") || brand.includes("boox")) return true;
    if (brand.includes("kobo") || brand.includes("kindle")) return true;
    if (manufacturer.includes("eink") || manufacturer.includes("e-ink")) return true;

    return false;
  } catch {
    return false;
  }
}

const DisplayContext = createContext<DisplaySettings>(DEFAULT_SETTINGS);

export function DisplayProvider({ children }: { children: ReactNode }) {
  // Use explicit selectors — zustand v5 requires them, or
  // useSyncExternalStore's snapshot churns on every render and React
  // bails with "Maximum update depth exceeded".
  const settings = useDisplayStore((s) => s.settings);
  const hydrated = useDisplayStore((s) => s.hydrated);
  const hydrate = useDisplayStore((s) => s.hydrate);
  const applyDetection = useDisplayStore((s) => s.applyDetection);

  // 1. Read stored override (async).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await getItem(STORAGE_KEY);
        if (cancelled) return;
        hydrate(raw === "1" ? true : raw === "0" ? false : null);
      } catch {
        if (!cancelled) hydrate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // 2. After hydration, apply detection only if no override exists.
  // applyDetection itself is a no-op when userOverride !== null, but
  // we still gate on `hydrated` so we don't read userOverride while
  // it's still its initial null pre-hydration value.
  useEffect(() => {
    if (!hydrated) return;
    applyDetection(detectEinkDevice());
  }, [hydrated, applyDetection]);

  return (
    <DisplayContext.Provider value={settings}>
      {children}
    </DisplayContext.Provider>
  );
}

export function useDisplay(): DisplaySettings {
  return useContext(DisplayContext);
}
