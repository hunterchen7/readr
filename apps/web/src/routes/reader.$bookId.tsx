import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, useCallback, useEffect } from "react";
import { getBook } from "@/lib/api";

export const Route = createFileRoute("/reader/$bookId")({
  component: WebReaderPage,
});

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

function WebReaderPage() {
  const { bookId } = Route.useParams();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [theme, setTheme] = useState<"light" | "sepia" | "dark">("light");

  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId),
  });

  const book = data?.book;

  const sendToReader = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ type, payload }),
        "*",
      );
    },
    [],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      try {
        const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        switch (msg.type) {
          case "ready":
            applyTheme(theme);
            break;
          case "progressUpdated":
            setProgress(msg.payload.percentage ?? 0);
            break;
          case "tocLoaded":
            setToc(msg.payload.chapters ?? []);
            break;
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [theme]);

  function applyTheme(t: string) {
    const themes: Record<string, { bg: string; fg: string; fontSize: number }> = {
      light: { bg: "#ffffff", fg: "#111111", fontSize: 18 },
      sepia: { bg: "#f4ecd8", fg: "#5c4b37", fontSize: 18 },
      dark: { bg: "#1a1a2e", fg: "#e0e0e0", fontSize: 18 },
    };
    sendToReader("setTheme", themes[t] ?? themes.light);
  }

  function handleThemeChange(t: "light" | "sepia" | "dark") {
    setTheme(t);
    applyTheme(t);
  }

  if (isLoading) return <p className="p-8 text-gray-500">Loading...</p>;
  if (error) return <p className="p-8 text-red-600">{error.message}</p>;
  if (!book) return <p className="p-8 text-red-600">Book not found</p>;

  const format = book.format ?? "epub";
  const readerHtml = format === "pdf"
    ? getPdfReaderHtml(book.downloadUrl!)
    : getEpubReaderHtml(book.downloadUrl!);

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Link
          to="/book/$bookId"
          params={{ bookId }}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          &larr; Back
        </Link>
        <h1 className="max-w-md truncate text-sm font-medium">
          {book.title ?? "Reading"}
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
          >
            TOC
          </button>
          {(["light", "sepia", "dark"] as const).map((t) => (
            <button
              key={t}
              onClick={() => handleThemeChange(t)}
              className={`rounded px-2 py-1 text-xs capitalize ${
                theme === t ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {showSidebar ? (
          <div className="w-64 overflow-y-auto border-r bg-gray-50 p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-600">
              Table of Contents
            </h2>
            {toc.map((item, i) => (
              <button
                key={i}
                onClick={() => {
                  sendToReader("goToChapter", { href: item.href });
                  setShowSidebar(false);
                }}
                className="block w-full truncate py-1.5 text-left text-sm text-gray-700 hover:text-gray-900"
                style={{ paddingLeft: `${item.depth * 16}px` }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Reader iframe */}
        <iframe
          ref={iframeRef}
          srcDoc={readerHtml}
          className="flex-1 border-0"
          title="Book reader"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>

      {/* Progress bar */}
      <div className="relative h-5 border-t bg-white px-3">
        <div
          className="absolute inset-y-0 left-0 bg-gray-100"
          style={{ width: `${progress}%` }}
        />
        <span className="relative text-xs text-gray-400">{progress}%</span>
      </div>
    </div>
  );
}

// ─── Inline reader HTML generators ──────────────────────────────────
// These are simplified versions of the mobile HTML generators,
// adapted for iframe communication instead of React Native WebView.

function getEpubReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: var(--bg, #fff); color: var(--fg, #111); }
    #viewer { width: 100%; height: 100%; }
    foliate-view { width: 100%; height: 100%; }
    #loading { display: flex; justify-content: center; align-items: center; height: 100%; font-family: system-ui; }
  </style>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="viewer" style="display:none;"></div>

  <script type="module">
    import 'https://cdn.jsdelivr.net/npm/foliate-js@0.5/view.js';

    const viewer = document.getElementById('viewer');
    const loading = document.getElementById('loading');

    function sendMessage(type, payload) {
      window.parent.postMessage(JSON.stringify({ type, payload }), '*');
    }

    window.addEventListener('message', (e) => {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        handleCommand(msg.type, msg.payload);
      } catch {}
    });

    function handleCommand(type, payload) {
      switch (type) {
        case 'setTheme':
          document.documentElement.style.setProperty('--bg', payload.bg);
          document.documentElement.style.setProperty('--fg', payload.fg);
          if (view) view.renderer?.setStyles?.({ fontSize: payload.fontSize + 'px' });
          break;
        case 'goToChapter':
          if (view) view.goTo(payload.href);
          break;
        case 'prevPage':
          if (view) view.goLeft();
          break;
        case 'nextPage':
          if (view) view.goRight();
          break;
      }
    }

    let view = null;
    async function init() {
      try {
        const res = await fetch('${bookUrl}');
        const blob = await res.blob();

        const el = document.createElement('foliate-view');
        el.setAttribute('flow', 'paginated');
        viewer.appendChild(el);

        await el.open(blob);
        view = el;

        loading.style.display = 'none';
        viewer.style.display = 'block';

        // Report TOC
        if (view.book?.toc) {
          const flatten = (items, depth = 0) =>
            items.flatMap(item => [
              { label: item.label, href: item.href, depth },
              ...(item.subitems ? flatten(item.subitems, depth + 1) : [])
            ]);
          sendMessage('tocLoaded', { chapters: flatten(view.book.toc) });
        }

        // Track progress
        view.addEventListener('relocate', (e) => {
          const frac = e.detail?.fraction ?? 0;
          sendMessage('progressUpdated', {
            percentage: Math.round(frac * 100),
            cfi: e.detail?.cfi,
          });
        });

        sendMessage('ready', {});
      } catch (err) {
        loading.textContent = 'Failed to load book: ' + err.message;
      }
    }

    init();
  </script>
</body>
</html>`;
}

function getPdfReaderHtml(bookUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow-y: auto; background: var(--bg, #f5f5f5); }
    #pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px; }
    canvas { max-width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    #loading { display: flex; justify-content: center; align-items: center; height: 100%; font-family: system-ui; }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="pages" style="display:none;"></div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs" type="module"></script>
  <script type="module">
    const pdfjsLib = window['pdfjs-dist/build/pdf'] ?? await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

    const loading = document.getElementById('loading');
    const pages = document.getElementById('pages');

    function sendMessage(type, payload) {
      window.parent.postMessage(JSON.stringify({ type, payload }), '*');
    }

    window.addEventListener('message', (e) => {
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (msg.type === 'setTheme') {
          document.documentElement.style.setProperty('--bg', msg.payload.bg);
        }
      } catch {}
    });

    try {
      const pdf = await pdfjsLib.getDocument('${bookUrl}').promise;
      const totalPages = pdf.numPages;

      loading.style.display = 'none';
      pages.style.display = 'flex';

      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        pages.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }

      // Scroll-based progress tracking
      document.addEventListener('scroll', () => {
        const scrollTop = document.documentElement.scrollTop;
        const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
        const pct = scrollHeight > 0 ? Math.round((scrollTop / scrollHeight) * 100) : 0;
        sendMessage('progressUpdated', { percentage: pct });
      });

      sendMessage('ready', {});
    } catch (err) {
      loading.textContent = 'Failed to load PDF: ' + err.message;
    }
  </script>
</body>
</html>`;
}
