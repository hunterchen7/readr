/**
 * Web implementation of DragDropUpload. Renders a full-size `<div>`
 * wrapper around `children` that listens for HTML5 drag-and-drop
 * events. When files are dropped, they're handed to `onFiles`. While a
 * drag is hovering, we overlay a dashed border + "Drop to upload"
 * banner so the user gets the standard web feedback the old dashboard
 * had.
 *
 * This file is picked by Metro's platform resolver on web and has no
 * native-only imports, so it's safe to live alongside the RN app.
 */
import { ReactNode, useRef, useState } from "react";

interface Props {
  children: ReactNode;
  onFiles: (files: File[]) => void;
}

export function DragDropUpload({ children, onFiles }: Props) {
  const [dragOver, setDragOver] = useState(false);
  // We count enter/leave so nested children dragging in/out of a
  // child element (e.g. a FlatList row) don't clear the highlight.
  const dragDepth = useRef(0);

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onFiles(files);
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
      {dragOver ? (
        <div
          style={{
            position: "absolute",
            inset: 12,
            border: "2px dashed #111",
            borderRadius: 12,
            background: "rgba(255,255,255,0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "#111",
              textAlign: "center",
              padding: 24,
            }}
          >
            Drop EPUB or PDF files to upload
          </div>
        </div>
      ) : null}
    </div>
  );
}
