import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  FlatList,
  Alert,
  useWindowDimensions,
} from "react-native";
import { useState } from "react";
import { router } from "expo-router";
import { Home } from "lucide-react-native";
import type { Bookmark } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";
import { colors, spacing, fontSize } from "../../lib/theme";

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

interface TocDrawerProps {
  visible: boolean;
  onClose: () => void;
  toc: TocItem[];
  bookmarks: Bookmark[];
  onGoToChapter: (href: string) => void;
  onJumpToBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
  theme: { bg: string; fg: string };
}

export function TocDrawer({
  visible,
  onClose,
  toc,
  bookmarks,
  onGoToChapter,
  onJumpToBookmark,
  onDeleteBookmark,
  theme,
}: TocDrawerProps) {
  const display = useDisplay();
  const { width: screenWidth } = useWindowDimensions();
  const [tab, setTab] = useState<"chapters" | "bookmarks">("chapters");

  if (!visible) return null;

  const drawerWidth = Math.min(screenWidth * 0.8, 320);

  return (
    <Modal
      transparent
      animationType={display.animationsEnabled ? "slide" : "none"}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <View
          style={[
            styles.drawer,
            { width: drawerWidth, backgroundColor: theme.bg },
          ]}
        >
          {/* Back to library */}
          <Pressable
            style={styles.backRow}
            onPress={() => {
              onClose();
              router.back();
            }}
            accessibilityLabel="Back to library"
          >
            <Home size={18} color={theme.fg} />
            <Text style={[styles.backText, { color: theme.fg }]}>
              Back to Library
            </Text>
          </Pressable>

          {/* Tabs */}
          <View
            style={[styles.tabs, { borderBottomColor: theme.fg + "22" }]}
          >
            {(["chapters", "bookmarks"] as const).map((t) => {
              const active = tab === t;
              return (
                <Pressable
                  key={t}
                  style={[
                    styles.tab,
                    active && { borderBottomColor: theme.fg, borderBottomWidth: 2 },
                  ]}
                  onPress={() => setTab(t)}
                >
                  <Text
                    style={[
                      styles.tabText,
                      { color: active ? theme.fg : theme.fg + "66" },
                      active && styles.tabTextActive,
                    ]}
                  >
                    {t === "chapters" ? "Chapters" : "Bookmarks"}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Content */}
          {tab === "chapters" ? (
            <FlatList
              data={toc}
              keyExtractor={(_, i) => String(i)}
              style={styles.list}
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    styles.chapterItem,
                    {
                      paddingLeft: spacing.lg + item.depth * 16,
                      borderBottomColor: theme.fg + "11",
                    },
                  ]}
                  onPress={() => {
                    onGoToChapter(item.href);
                    onClose();
                  }}
                >
                  <Text
                    style={[styles.chapterLabel, { color: theme.fg }]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              )}
            />
          ) : (
            <FlatList
              data={bookmarks}
              keyExtractor={(item) => item.id}
              style={styles.list}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: theme.fg + "66" }]}>
                  No bookmarks yet.
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[
                    styles.bookmarkItem,
                    { borderBottomColor: theme.fg + "11" },
                  ]}
                  onPress={() => {
                    onJumpToBookmark(item);
                    onClose();
                  }}
                  onLongPress={() => {
                    Alert.alert(
                      "Delete Bookmark?",
                      item.label ?? "This bookmark",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => onDeleteBookmark(item.id),
                        },
                      ],
                    );
                  }}
                >
                  <Text
                    style={[styles.bookmarkLabel, { color: theme.fg }]}
                    numberOfLines={1}
                  >
                    {item.label ??
                      `Page ${item.position.page ?? Math.round(item.position.percentage) + "%"}`}
                  </Text>
                  <Text style={[styles.bookmarkPct, { color: theme.fg + "66" }]}>
                    {Math.round(item.position.percentage)}%
                  </Text>
                </Pressable>
              )}
            />
          )}
        </View>

        {/* Backdrop to close */}
        <Pressable style={styles.backdrop} onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: "row",
  },
  drawer: {
    flex: 0,
    height: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl + 24,
    paddingBottom: spacing.md,
  },
  backText: {
    fontSize: fontSize.md,
    fontWeight: "500",
  },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  tabText: {
    fontSize: fontSize.md,
  },
  tabTextActive: {
    fontWeight: "600",
  },
  list: {
    flex: 1,
  },
  chapterItem: {
    paddingVertical: spacing.md,
    paddingRight: spacing.lg,
    borderBottomWidth: 1,
  },
  chapterLabel: {
    fontSize: fontSize.lg,
  },
  bookmarkItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
  },
  bookmarkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    marginRight: spacing.sm,
  },
  bookmarkPct: {
    fontSize: fontSize.xs,
  },
  emptyText: {
    textAlign: "center",
    paddingVertical: spacing.xxl,
    fontSize: fontSize.sm,
  },
});
