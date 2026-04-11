/**
 * Cross-platform drag-and-drop upload wrapper.
 *
 * - Native (iOS/Android): this file is used. Pass-through — there's no
 *   OS-level drag-and-drop for files into RN apps, so children are
 *   rendered unchanged and the upload flow relies on the + button /
 *   DocumentPicker.
 * - Web: `DragDropUpload.web.tsx` takes over and wraps children in a
 *   drop zone that surfaces dragged files to `onFiles`.
 */
import { ReactNode } from "react";

interface Props {
  children: ReactNode;
  onFiles: (files: File[]) => void;
}

export function DragDropUpload({ children }: Props) {
  return <>{children}</>;
}
