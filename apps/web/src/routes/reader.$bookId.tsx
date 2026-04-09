import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, useCallback, useEffect } from "react";
import { getBook, getProgress, saveProgress } from "@/lib/api";

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
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [chapter, setChapter] = useState("");
  const [theme, setTheme] = useState<"light" | "sepia" | "dark">("light");
  const [fontSize, setFontSize] = useState(18);

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

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const savedCfiRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getProgress(bookId).then(({ positions }) => {
      if (positions.length > 0) {
        const latest = positions.sort((a, b) => (b.position.percentage ?? 0) - (a.position.percentage ?? 0))[0];
        if (latest.position.cfi) savedCfiRef.current = latest.position.cfi;
        setProgress(latest.position.percentage ?? 0);
      }
    }).catch(() => {});
  }, [bookId]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      try {
        const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        switch (msg.type) {
          case "ready":
            applyTheme(themeRef.current, fontSizeRef.current);
            if (savedCfiRef.current) {
              sendToReader("goToLocation", { cfi: savedCfiRef.current });
            }
            break;
          case "progressUpdated": {
            const pct = msg.payload.percentage ?? 0;
            const cfi = msg.payload.cfi;
            setProgress(pct);
            if (msg.payload.chapter) setChapter(msg.payload.chapter);
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
              saveProgress(bookId, { percentage: pct, cfi }).catch(() => {});
            }, 3000);
            break;
          }
          case "tocLoaded":
            setToc(msg.payload.chapters ?? []);
            break;
        }
      } catch {}
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [bookId]);

  function applyTheme(t: string, fs: number) {
    const themes: Record<string, { bg: string; fg: string }> = {
      light: { bg: "#ffffff", fg: "#111111" },
      sepia: { bg: "#f4ecd8", fg: "#5c4b37" },
      dark: { bg: "#1a1a2e", fg: "#e0e0e0" },
    };
    const th = themes[t] ?? themes.light;
    sendToReader("setTheme", { ...th, fontSize: fs });
  }

  function handleThemeChange(t: "light" | "sepia" | "dark") {
    setTheme(t);
    applyTheme(t, fontSize);
  }

  function handleFontSize(delta: number) {
    const next = Math.max(12, Math.min(32, fontSize + delta));
    setFontSize(next);
    applyTheme(theme, next);
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }
  if (error || !book) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-red-600">{error?.message ?? "Book not found"}</p>
      </div>
    );
  }

  const format = book.format ?? "epub";
  const readerHtml = format === "pdf"
    ? getPdfReaderHtml(book.downloadUrl!)
    : getEpubReaderHtml(book.downloadUrl!);

  const themeBg = theme === "dark" ? "#1a1a2e" : theme === "sepia" ? "#f4ecd8" : "#ffffff";
  const themeFg = theme === "dark" ? "#e0e0e0" : theme === "sepia" ? "#5c4b37" : "#111111";

  return (
    <div className="flex h-screen flex-col" style={{ backgroundColor: themeBg, color: themeFg }}>
      {/* Header — minimal, blends with theme */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderBottom: `1px solid ${theme === "dark" ? "#333" : "#e5e5e5"}` }}
      >
        <Link
          to="/library"
          className="rounded-md px-2 py-1 text-sm opacity-60 transition-opacity hover:opacity-100"
          style={{ color: themeFg }}
        >
          ← Library
        </Link>
        <div className="flex flex-col items-center">
          <span className="max-w-xs truncate text-sm font-medium">{book.title ?? "Reading"}</span>
          {chapter ? <span className="text-[11px] opacity-50">{chapter}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowToc((o) => !o); setShowSettings(false); }}
            className={`rounded-md px-2 py-1 text-sm transition-colors ${showToc ? "bg-black/10" : "opacity-60 hover:opacity-100"}`}
            style={{ color: themeFg }}
          >
            ☰
          </button>
          <button
            onClick={() => { setShowSettings((o) => !o); setShowToc(false); }}
            className={`rounded-md px-2 py-1 text-sm transition-colors ${showSettings ? "bg-black/10" : "opacity-60 hover:opacity-100"}`}
            style={{ color: themeFg }}
          >
            Aa
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 overflow-hidden">
        {/* TOC sidebar */}
        {showToc ? (
          <div
            className="w-72 overflow-y-auto border-r p-4"
            style={{
              backgroundColor: theme === "dark" ? "#111" : "#fafafa",
              borderColor: theme === "dark" ? "#333" : "#e5e5e5",
            }}
          >
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider opacity-50">
              Contents
            </h2>
            {toc.length === 0 ? (
              <p className="text-sm opacity-40">No table of contents</p>
            ) : (
              toc.map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    sendToReader("goToChapter", { href: item.href });
                    setShowToc(false);
                  }}
                  className="block w-full truncate py-1.5 text-left text-sm opacity-70 transition-opacity hover:opacity-100"
                  style={{ paddingLeft: `${8 + item.depth * 16}px`, color: themeFg }}
                >
                  {item.label}
                </button>
              ))
            )}
          </div>
        ) : null}

        {/* Settings panel */}
        {showSettings ? (
          <div
            className="absolute right-0 top-0 z-10 w-64 border-l p-4 shadow-lg"
            style={{
              backgroundColor: theme === "dark" ? "#111" : "#fff",
              borderColor: theme === "dark" ? "#333" : "#e5e5e5",
              height: "100%",
            }}
          >
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider opacity-50">
              Settings
            </h2>

            {/* Font size */}
            <div className="mb-4">
              <label className="mb-2 block text-xs opacity-50">Font size</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleFontSize(-2)}
                  className="flex h-8 w-8 items-center justify-center rounded border text-sm"
                  style={{ borderColor: theme === "dark" ? "#444" : "#ddd", color: themeFg }}
                >
                  A-
                </button>
                <span className="min-w-[3ch] text-center text-sm">{fontSize}</span>
                <button
                  onClick={() => handleFontSize(2)}
                  className="flex h-8 w-8 items-center justify-center rounded border text-sm font-bold"
                  style={{ borderColor: theme === "dark" ? "#444" : "#ddd", color: themeFg }}
                >
                  A+
                </button>
              </div>
            </div>

            {/* Theme */}
            <div>
              <label className="mb-2 block text-xs opacity-50">Theme</label>
              <div className="flex gap-2">
                {([
                  { key: "light", label: "Light", bg: "#fff", fg: "#111" },
                  { key: "sepia", label: "Sepia", bg: "#f4ecd8", fg: "#5c4b37" },
                  { key: "dark", label: "Dark", bg: "#1a1a2e", fg: "#e0e0e0" },
                ] as const).map((t) => (
                  <button
                    key={t.key}
                    onClick={() => handleThemeChange(t.key)}
                    className={`flex-1 rounded-md border py-2 text-xs font-medium transition-all ${
                      theme === t.key ? "ring-2 ring-blue-500" : ""
                    }`}
                    style={{
                      backgroundColor: t.bg,
                      color: t.fg,
                      borderColor: theme === "dark" ? "#444" : "#ddd",
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Nav buttons */}
        <button
          onClick={() => sendToReader("prevPage", {})}
          className="absolute left-0 top-0 z-[5] flex h-full w-12 items-center justify-center opacity-0 transition-opacity hover:opacity-60"
          style={{ color: themeFg }}
          aria-label="Previous page"
        >
          ‹
        </button>
        <button
          onClick={() => sendToReader("nextPage", {})}
          className="absolute right-0 top-0 z-[5] flex h-full w-12 items-center justify-center opacity-0 transition-opacity hover:opacity-60"
          style={{ color: themeFg }}
          aria-label="Next page"
        >
          ›
        </button>

        {/* Reader iframe */}
        <iframe
          ref={iframeRef}
          srcDoc={readerHtml}
          className="flex-1 border-0"
          title="Book reader"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>

      {/* Bottom bar — progress */}
      <div
        className="flex items-center gap-3 px-4 py-2"
        style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#e5e5e5"}` }}
      >
        <span className="min-w-[3ch] text-xs opacity-40">{progress}%</span>
        <div
          className="relative h-1 flex-1 cursor-pointer rounded-full"
          style={{ backgroundColor: theme === "dark" ? "#333" : "#e5e5e5" }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const pct = Math.round(Math.max(0, Math.min(100, frac * 100)));
            sendToReader("goToFraction", { fraction: frac });
            setProgress(pct);
          }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-blue-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Inline reader HTML generators ──────────────────────────────────

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
    #loading { display: flex; justify-content: center; align-items: center; height: 100%; font-family: system-ui; color: #999; }
  </style>
</head>
<body>
  <div id="loading">Loading book...</div>
  <div id="viewer" style="display:none;"></div>

  <script type="module">
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
          document.body.style.background = payload.bg;
          if (view) view.renderer?.setStyles?.({ fontSize: payload.fontSize + 'px' });
          break;
        case 'goToChapter':
          if (view) view.goTo(payload.href);
          break;
        case 'goToLocation':
          if (view && payload.cfi) view.goTo(payload.cfi);
          break;
        case 'goToFraction':
          if (view && typeof payload.fraction === 'number') view.goToFraction(payload.fraction);
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
        const { makeBook } = await import('https://cdn.jsdelivr.net/npm/foliate-js@1.0.1/view.js');

        const res = await fetch('${bookUrl}');
        if (!res.ok) throw new Error('Failed to fetch book (' + res.status + ')');
        const blob = await res.blob();
        const file = new File([blob], 'book.epub', { type: blob.type || 'application/epub+zip' });

        const book = await makeBook(file);

        const el = document.createElement('foliate-view');
        viewer.appendChild(el);
        el.setAttribute('flow', 'paginated');

        await el.open(book);
        view = el;

        // Navigate to the first section so content renders immediately
        try { await el.goTo(book.toc?.[0]?.href ?? book.sections?.[0]?.id ?? 0); } catch {};

        loading.style.display = 'none';
        viewer.style.display = 'block';

        if (view.book?.toc) {
          const flatten = (items, depth = 0) =>
            items.flatMap(item => [
              { label: item.label, href: item.href, depth },
              ...(item.subitems ? flatten(item.subitems, depth + 1) : [])
            ]);
          sendMessage('tocLoaded', { chapters: flatten(view.book.toc) });
        }

        view.addEventListener('relocate', (e) => {
          const d = e.detail;
          sendMessage('progressUpdated', {
            percentage: Math.round((d.fraction ?? 0) * 100),
            cfi: d.cfi,
            chapter: d.tocItem?.label ?? '',
          });
        });

        // Click navigation
        viewer.addEventListener('click', (e) => {
          const x = e.clientX / window.innerWidth;
          if (x < 0.3) view.goLeft();
          else if (x > 0.7) view.goRight();
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowLeft' || e.key === 'PageUp') view.goLeft();
          else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') view.goRight();
        });

        sendMessage('ready', {});
      } catch (err) {
        loading.textContent = 'Failed to load: ' + err.message;
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
    .page-slot { display: flex; justify-content: center; align-items: center; background: #e5e5e5; }
    .page-slot canvas { max-width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    #loading { display: flex; justify-content: center; align-items: center; height: 100%; font-family: system-ui; color: #999; }
  </style>
</head>
<body>
  <div id="loading">Loading PDF...</div>
  <div id="pages" style="display:none;"></div>

  <script type="module">
    const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
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
          document.body.style.background = msg.payload.bg;
        }
      } catch {}
    });

    try {
      const pdf = await pdfjsLib.getDocument('${bookUrl}').promise;
      const totalPages = pdf.numPages;

      loading.style.display = 'none';
      pages.style.display = 'flex';

      const rendered = new Set();
      const slots = [];
      const firstPage = await pdf.getPage(1);
      const defaultVp = firstPage.getViewport({ scale: 1.5 });

      for (let i = 1; i <= totalPages; i++) {
        const slot = document.createElement('div');
        slot.className = 'page-slot';
        slot.style.width = defaultVp.width + 'px';
        slot.style.height = defaultVp.height + 'px';
        slot.dataset.page = String(i);
        pages.appendChild(slot);
        slots.push(slot);
      }

      const canvas1 = document.createElement('canvas');
      canvas1.width = defaultVp.width;
      canvas1.height = defaultVp.height;
      slots[0].appendChild(canvas1);
      await firstPage.render({ canvasContext: canvas1.getContext('2d'), viewport: defaultVp }).promise;
      rendered.add(1);

      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNum = parseInt(entry.target.dataset.page, 10);
          if (rendered.has(pageNum)) continue;
          rendered.add(pageNum);
          renderPage(pageNum, entry.target);
        }
      }, { rootMargin: '200% 0px' });

      for (const slot of slots) observer.observe(slot);

      async function renderPage(num, slot) {
        const page = await pdf.getPage(num);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        slot.style.width = viewport.width + 'px';
        slot.style.height = viewport.height + 'px';
        slot.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }

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
