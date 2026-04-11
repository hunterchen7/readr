import { ActivityIndicator, type ActivityIndicatorProps, Text } from "react-native";
import { useDisplay } from "../contexts/DisplayContext";

interface LoadingIndicatorProps extends ActivityIndicatorProps {
  label?: string;
}

/**
 * Shows a spinning ActivityIndicator on normal displays and a static text
 * label on e-ink devices. The A5X can't animate at ≥1Hz without ghosting,
 * so a continuously-spinning wheel reads as an unreadable gray smudge.
 *
 * On e-ink the caller's `color` prop is ignored — callers typically pass
 * muted gray values that render as low-contrast smudges, so we force
 * solid black for legibility against any reader theme.
 */
export function LoadingIndicator({ label = "Loading…", color, ...rest }: LoadingIndicatorProps) {
  const display = useDisplay();
  if (display.isEink) {
    return <Text style={{ color: "#000", fontSize: 14, fontWeight: "600" }}>{label}</Text>;
  }
  return <ActivityIndicator color={color} {...rest} />;
}
