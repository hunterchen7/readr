/**
 * Web-only tabs layout. On native, `_layout.tsx` renders Expo
 * Router's default bottom tab bar — fine on phones, weird on a
 * 1920px desktop viewport. Here we keep the same `<Tabs>` component
 * (so route resolution / focus / history works identically to
 * native) but swap the tab bar render prop for a top nav.
 *
 * This file is picked automatically by Metro's platform resolution
 * when building the web bundle.
 */
import { Tabs } from "expo-router";
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { Library, BarChart3, Settings } from "lucide-react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { colors, spacing, fontSize } from "../../lib/theme";

/**
 * Top navbar replacement for the default bottom tab bar. Renders
 * the same Library / Reading / Settings items, inline at the top
 * of the viewport. Narrow widths (<640 px) fall back to rendering
 * the names underneath the icons so everything still fits.
 */
function TopNavBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { width } = useWindowDimensions();
  const compact = width < 640;

  return (
    <View style={styles.bar}>
      <View style={styles.barInner}>
        {compact ? null : <Text style={styles.brand}>Readr</Text>}
        <View style={styles.links}>
          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            const label =
              typeof options.tabBarLabel === "string"
                ? options.tabBarLabel
                : (options.title ?? route.name);
            const isFocused = state.index === index;

            const Icon =
              route.name === "library"
                ? Library
                : route.name === "stats"
                  ? BarChart3
                  : Settings;

            return (
              <Pressable
                key={route.key}
                accessibilityRole="button"
                accessibilityState={isFocused ? { selected: true } : {}}
                accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
                style={[
                  styles.link,
                  compact && styles.linkCompact,
                  isFocused && styles.linkActive,
                ]}
                onPress={() => {
                  const event = navigation.emit({
                    type: "tabPress",
                    target: route.key,
                    canPreventDefault: true,
                  });
                  if (!isFocused && !event.defaultPrevented) {
                    navigation.navigate(route.name, route.params);
                  }
                }}
              >
                <Icon
                  size={18}
                  color={isFocused ? colors.text : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.linkText,
                    isFocused && styles.linkTextActive,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <TopNavBar {...props} />}
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textMuted,
        headerShown: false,
        // On web the custom tabBar is rendered at the top of the
        // viewport. Default position: "bottom" still works but we
        // pin it to "top" so react-navigation's internal layout
        // doesn't reserve space at the bottom of the screen area
        // for the bar we're not drawing there.
        tabBarPosition: "top",
      }}
    >
      <Tabs.Screen
        name="library"
        options={{ title: "Library" }}
      />
      <Tabs.Screen
        name="stats"
        options={{ title: "Reading" }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings" }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  barInner: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 1440,
    width: "100%",
    marginHorizontal: "auto",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.lg,
  },
  brand: {
    fontSize: fontSize.lg,
    fontWeight: "700",
    color: colors.text,
    marginRight: spacing.md,
  },
  links: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  linkCompact: {
    flexDirection: "column",
    gap: 2,
    paddingHorizontal: spacing.sm,
  },
  linkActive: {
    backgroundColor: colors.backgroundSecondary,
  },
  linkText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  linkTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
});
