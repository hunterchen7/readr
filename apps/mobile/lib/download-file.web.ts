/**
 * Web implementation of downloadFile. Builds an anchor with the
 * `download` attribute and clicks it. Browsers honour the suggested
 * filename on same-origin URLs; on cross-origin URLs (our presigned
 * R2 downloads are cross-origin) the attribute is ignored and the
 * browser falls back to the URL/header filename. Either way the file
 * lands in the user's Downloads folder.
 */
export async function downloadFile(
  url: string,
  filename: string,
): Promise<void> {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Opening in a new tab as a fallback for the cross-origin case —
  // if the download attribute is ignored, the file still opens in a
  // tab the user can save from.
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
