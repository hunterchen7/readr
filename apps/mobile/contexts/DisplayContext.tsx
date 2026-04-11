import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { Platform, NativeModules } from "react-native";
import { create } from "zustand";

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

export const useDisplayStore = create<{
  settings: DisplaySettings;
  setIsEink: (isEink: boolean) => void;
  toggleEink: () => void;
}>((set) => ({
  settings: DEFAULT_SETTINGS,
  setIsEink: (isEink: boolean) =>
    set({ settings: isEink ? EINK_SETTINGS : DEFAULT_SETTINGS }),
  toggleEink: () =>
    set((state) => ({
      settings: state.settings.isEink ? DEFAULT_SETTINGS : EINK_SETTINGS,
    })),
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
  const setIsEink = useDisplayStore((s) => s.setIsEink);

  useEffect(() => {
    const isEink = detectEinkDevice();
    if (isEink) setIsEink(true);
  }, [setIsEink]);

  return (
    <DisplayContext.Provider value={settings}>
      {children}
    </DisplayContext.Provider>
  );
}

export function useDisplay(): DisplaySettings {
  return useContext(DisplayContext);
}
