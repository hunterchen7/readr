import { ActivityIndicator, type ActivityIndicatorProps, Text } from "react-native";
import { useDisplay } from "../contexts/DisplayContext";

interface LoadingIndicatorProps extends ActivityIndicatorProps {
  label?: string;
}

/**
 * Shows a spinning ActivityIndicator on normal displays and a static text
 * label on e-ink devices. The A5X can't animate at ≥1Hz without ghosting,
 * so a continuously-spinning wheel reads as an unreadable gray smudge.
 */
export function LoadingIndicator({ label = "Loading…", color, ...rest }: LoadingIndicatorProps) {
  const display = useDisplay();
  if (display.isEink) {
    return <Text style={{ color: typeof color === "string" ? color : "#000", fontSize: 14 }}>{label}</Text>;
  }
  return <ActivityIndicator color={color} {...rest} />;
}
