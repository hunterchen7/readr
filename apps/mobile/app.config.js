/**
 * Expo app config. We use a .js config instead of app.json so we can
 * pull build-time defaults out of the shell environment.
 *
 * Supported env vars:
 *   EXPO_PUBLIC_DEFAULT_SERVER_URL — pre-fills the Server URL field on
 *     the login screen. Handy for builds aimed at a known Olares / CF
 *     tunnel instance so users don't type it.
 *   EXPO_PUBLIC_APP_NAME — overrides the display name (e.g. "Readr Dev").
 */
module.exports = ({ config }) => ({
  ...config,
  name: process.env.EXPO_PUBLIC_APP_NAME ?? "Readr",
  slug: "readr",
  version: "0.0.1",
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  scheme: "readr",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.readr.app",
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    edgeToEdgeEnabled: true,
    package: "com.readr.app",
  },
  plugins: ["expo-router", "expo-secure-store"],
  extra: {
    defaultServerUrl: process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL ?? "",
  },
});
