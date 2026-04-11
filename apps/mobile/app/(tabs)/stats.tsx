import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getStatsSummary, getStatsDaily } from "../../lib/api";
import { LoadingIndicator } from "../../components/LoadingIndicator";

export default function StatsScreen() {
  const insets = useSafeAreaInsets();

  const summary = useQuery({
    queryKey: ["stats", "summary"],
    queryFn: getStatsSummary,
  });
  const daily = useQuery({
    queryKey: ["stats", "daily"],
    queryFn: getStatsDaily,
  });

  const loading = summary.isLoading || daily.isLoading;
  const dailyData = daily.data?.daily ?? [];

  // Normalize to 30 days so the bar chart has a consistent width.
  const days30 = buildLast30Days(dailyData);
  const maxMinutes = days30.reduce((m, d) => Math.max(m, d.minutes), 0);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 40 }}
    >
      <Text style={styles.title}>Reading</Text>

      {loading ? (
        <View style={styles.center}>
          <LoadingIndicator />
        </View>
      ) : summary.data ? (
        <>
          <View style={styles.statGrid}>
            <StatCard
              label="Total time"
              value={formatMinutes(summary.data.totalReadingMinutes)}
            />
            <StatCard
              label="This week"
              value={formatMinutes(summary.data.weeklyMinutes)}
            />
            <StatCard
              label="Streak"
              value={`${summary.data.currentStreak}d`}
            />
            <StatCard
              label="Library"
              value={`${summary.data.totalBooks} books`}
            />
          </View>

          <Text style={styles.sectionTitle}>Last 30 days</Text>
          <View style={styles.chart}>
            {days30.map((d, i) => {
              const h = maxMinutes > 0 ? (d.minutes / maxMinutes) * 120 : 0;
              return (
                <View key={i} style={styles.barColumn}>
                  <View style={styles.barSlot}>
                    <View style={[styles.bar, { height: Math.max(h, 2) }]} />
                  </View>
                  {i % 7 === 0 ? (
                    <Text style={styles.barLabel}>
                      {new Date(d.date).getDate()}
                    </Text>
                  ) : (
                    <Text style={styles.barLabel}> </Text>
                  )}
                </View>
              );
            })}
          </View>

          <Text style={styles.muted}>
            Sessions are logged each time you leave a book. Short reads
            (under a minute) are ignored so idle taps don't pad the stats.
          </Text>
        </>
      ) : (
        <View style={styles.center}>
          <Text style={styles.muted}>Could not load stats.</Text>
        </View>
      )}
    </ScrollView>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function buildLast30Days(
  rows: { date: string; minutes: number }[],
): { date: string; minutes: number }[] {
  const byDate = new Map(rows.map((r) => [r.date.slice(0, 10), r.minutes]));
  const result: { date: string; minutes: number }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, minutes: byDate.get(key) ?? 0 });
  }
  return result;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  title: { fontSize: 22, fontWeight: "700", paddingHorizontal: 16, marginBottom: 16 },
  center: { padding: 40, alignItems: "center" },
  muted: { color: "#999", fontSize: 12, paddingHorizontal: 16, marginTop: 24 },

  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  statCard: {
    flexBasis: "47%",
    backgroundColor: "#f3f4f6",
    padding: 16,
    borderRadius: 12,
  },
  statValue: { fontSize: 24, fontWeight: "700", color: "#111" },
  statLabel: { fontSize: 12, color: "#666", marginTop: 4, textTransform: "uppercase" },

  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#666",
    paddingHorizontal: 16,
    marginBottom: 12,
    textTransform: "uppercase",
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    gap: 4,
    height: 160,
  },
  barColumn: { flex: 1, alignItems: "center", gap: 4 },
  barSlot: { height: 120, justifyContent: "flex-end", width: "100%" },
  bar: { backgroundColor: "#111", borderRadius: 2, width: "100%" },
  barLabel: { fontSize: 9, color: "#999" },
});
