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
import { Home, Trash2, Hash } from "lucide-react-native";
import type { Bookmark, Note, Highlight } from "@readr/shared";
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
  notes: Note[];
  highlights: Highlight[];
  /** href of the chapter currently visible in the reader, used to
   *  highlight the matching row in the chapters list. */
  currentChapterHref?: string | null;
  onGoToChapter: (href: string) => void;
  onGoToPage: () => void;
  onJumpToBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
  onJumpToNote: (note: Note) => void;
  onDeleteNote: (id: string) => void;
  onJumpToHighlight: (highlight: Highlight) => void;
  onDeleteHighlight: (id: string) => void;
  theme: { bg: string; fg: string };
}

function SortToggle({
  mode,
  onChange,
  fg,
}: {
  mode: "position" | "recent";
  onChange: (m: "position" | "recent") => void;
  fg: string;
}) {
  const chipBg = fg + "11";
  return (
    <View style={styles.sortRow}>
      {(["position", "recent"] as const).map((m) => {
        const active = mode === m;
        return (
          <Pressable
            key={m}
            style={[
              styles.sortChip,
              { backgroundColor: active ? fg : chipBg },
            ]}
            onPress={() => onChange(m)}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: active ? "600" : "400",
                color: active ? "#fff" : fg + "99",
              }}
            >
              {m === "position" ? "By position" : "By date"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function TocDrawer({
  visible,
  onClose,
  toc,
  bookmarks,
  notes,
  highlights,
  currentChapterHref,
  onGoToChapter,
  onGoToPage,
  onJumpToBookmark,
  onDeleteBookmark,
  onJumpToNote,
  onDeleteNote,
  onJumpToHighlight,
  onDeleteHighlight,
  theme,
}: TocDrawerProps) {
  const display = useDisplay();
  const { width: screenWidth } = useWindowDimensions();
  const [tab, setTab] = useState<"chapters" | "bookmarks" | "notes">("chapters");
  // Sort mode for bookmarks + notes/highlights list. "position" is
  // the default because it's far more useful when scanning a book;
  // "recent" keeps the old chronological view for "what did I add
  // most recently" workflows.
  const [sortMode, setSortMode] = useState<"position" | "recent">("position");

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

          {/* Go to specific page */}
          <Pressable
            style={[styles.backRow, styles.backRowCompact]}
            onPress={() => {
              onClose();
              onGoToPage();
            }}
            accessibilityLabel="Go to page"
          >
            <Hash size={18} color={theme.fg} />
            <Text style={[styles.backText, { color: theme.fg }]}>
              Go to page…
            </Text>
          </Pressable>

          {/* Tabs */}
          <View
            style={[styles.tabs, { borderBottomColor: theme.fg + "22" }]}
          >
            {(["chapters", "bookmarks", "notes"] as const).map((t) => {
              const active = tab === t;
              const labels = { chapters: "Chapters", bookmarks: "Bookmarks", notes: "Notes" };
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
                    {labels[t]}
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
              renderItem={({ item }) => {
                const isCurrent =
                  currentChapterHref != null && item.href === currentChapterHref;
                return (
                  <Pressable
                    style={[
                      styles.chapterItem,
                      {
                        paddingLeft: spacing.lg + item.depth * 16,
                        borderBottomColor: theme.fg + "11",
                      },
                      isCurrent && {
                        backgroundColor: theme.fg + "10",
                        borderLeftWidth: 3,
                        borderLeftColor: theme.fg,
                      },
                    ]}
                    onPress={() => {
                      onGoToChapter(item.href);
                      onClose();
                    }}
                  >
                    <Text
                      style={[
                        styles.chapterLabel,
                        { color: theme.fg },
                        isCurrent && { fontWeight: "700" },
                      ]}
                      numberOfLines={1}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              }}
            />
          ) : tab === "bookmarks" ? (
            <FlatList
              data={bookmarks.slice().sort((a, b) =>
                sortMode === "position"
                  ? a.position.percentage - b.position.percentage
                  : b.createdAt.localeCompare(a.createdAt),
              )}
              keyExtractor={(item) => item.id}
              style={styles.list}
              ListHeaderComponent={
                <SortToggle
                  mode={sortMode}
                  onChange={setSortMode}
                  fg={theme.fg}
                />
              }
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: theme.fg + "66" }]}>
                  No bookmarks yet. Tap the bookmark icon in the header to add one.
                </Text>
              }
              renderItem={({ item }) => (
                <View
                  style={[
                    styles.bookmarkItem,
                    { borderBottomColor: theme.fg + "11" },
                  ]}
                >
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => {
                      onJumpToBookmark(item);
                      onClose();
                    }}
                  >
                    <Text
                      style={[styles.bookmarkLabel, { color: theme.fg }]}
                      numberOfLines={1}
                    >
                      {item.label ?? item.position.chapterLabel ?? "Bookmark"}
                    </Text>
                  </Pressable>
                  <Text style={[styles.bookmarkPct, { color: theme.fg + "66" }]}>
                    {item.position.percentage.toFixed(1)}%
                  </Text>
                  <Pressable
                    onPress={() => onDeleteBookmark(item.id)}
                    style={styles.deleteBtn}
                  >
                    <Trash2 size={16} color={theme.fg + "66"} />
                  </Pressable>
                </View>
              )}
            />
          ) : (
            <FlatList
              data={[
                ...notes.map((n) => ({
                  type: "note" as const,
                  item: n,
                  at: n.createdAt,
                  pct: n.position.percentage,
                })),
                ...highlights.map((h) => ({
                  type: "highlight" as const,
                  item: h,
                  at: h.createdAt,
                  // Highlights created before the chapter/percentage
                  // columns existed have null percentage — treat
                  // those as "unknown position" and float them to the
                  // end in position-sorted view.
                  pct: h.percentage ?? Number.POSITIVE_INFINITY,
                })),
              ].sort((a, b) =>
                sortMode === "position"
                  ? a.pct - b.pct
                  : b.at.localeCompare(a.at),
              )}
              keyExtractor={(entry) => entry.item.id}
              style={styles.list}
              ListHeaderComponent={
                <SortToggle
                  mode={sortMode}
                  onChange={setSortMode}
                  fg={theme.fg}
                />
              }
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: theme.fg + "66" }]}>
                  No notes or highlights yet. Select text to add one.
                </Text>
              }
              renderItem={({ item: entry }) => (
                <Pressable
                  style={[styles.noteItem, { borderBottomColor: theme.fg + "11" }]}
                  onPress={() => {
                    if (entry.type === "note") onJumpToNote(entry.item as Note);
                    else onJumpToHighlight(entry.item as Highlight);
                    onClose();
                  }}
                >
                  {entry.type === "highlight" ? (
                    <>
                      <View style={[styles.highlightBar, { backgroundColor: (entry.item as Highlight).color || "#fef08a" }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.noteText, { color: theme.fg }]} numberOfLines={2}>
                          {(entry.item as Highlight).textContent || "Highlight"}
                        </Text>
                        {((entry.item as Highlight).percentage != null ||
                          (entry.item as Highlight).chapterLabel != null) && (
                          <Text
                            style={[styles.noteMeta, { color: theme.fg + "66" }]}
                            numberOfLines={1}
                          >
                            {[
                              (entry.item as Highlight).percentage != null
                                ? `${((entry.item as Highlight).percentage ?? 0).toFixed(1)}%`
                                : null,
                              (entry.item as Highlight).chapterLabel,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        )}
                      </View>
                      <Pressable
                        onPress={() => onDeleteHighlight(entry.item.id)}
                        style={styles.deleteBtn}
                      >
                        <Trash2 size={16} color={theme.fg + "66"} />
                      </Pressable>
                    </>
                  ) : (
                    <>
                      <View
                        style={[
                          styles.highlightBar,
                          {
                            backgroundColor:
                              (entry.item as Note).noteType === "handwritten"
                                ? "#6366f1"
                                : "#d97706",
                          },
                        ]}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.noteText, { color: theme.fg }]} numberOfLines={2}>
                          {(entry.item as Note).noteType === "handwritten" ? "Handwritten note" : ((entry.item as Note).textContent || "Note")}
                        </Text>
                        <Text style={[styles.noteMeta, { color: theme.fg + "66" }]} numberOfLines={1}>
                          {[
                            `${(entry.item as Note).position.percentage.toFixed(1)}%`,
                            (entry.item as Note).position.chapterLabel,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => onDeleteNote(entry.item.id)}
                        style={styles.deleteBtn}
                      >
                        <Trash2 size={16} color={theme.fg + "66"} />
                      </Pressable>
                    </>
                  )}
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
  backRowCompact: {
    paddingTop: spacing.sm,
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
  sortRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  sortChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 12,
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
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.sm,
  },
  deleteBtn: {
    padding: spacing.sm,
    marginLeft: spacing.sm,
  },
  noteItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: spacing.sm,
  },
  highlightBar: {
    width: 4,
    borderRadius: 2,
    alignSelf: "stretch",
  },
  noteText: {
    fontSize: fontSize.md,
  },
  noteMeta: {
    fontSize: fontSize.xs,
    marginTop: 2,
  },
});
