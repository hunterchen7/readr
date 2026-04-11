/**
 * Kick off a download of a remote file. Native implementation: opens
 * the URL in the system browser, which hands off to the OS's download
 * handler / share sheet. The `.web.ts` sibling does the equivalent via
 * a hidden `<a download>` click.
 *
 * Callers supply the suggested filename but most native handlers will
 * pick their own from the URL or Content-Disposition header — the
 * filename arg is only load-bearing on web.
 */
import * as Linking from "expo-linking";

export async function downloadFile(
  url: string,
  _filename: string,
): Promise<void> {
  await Linking.openURL(url);
}
