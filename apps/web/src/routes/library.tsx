import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listBooks, deleteBook, uploadBook, getToken } from "@/lib/api";
import { useToast } from "@/components/Toast";
import type { Book } from "@readr/shared";

type BookWithProgress = Book & { progressPct?: number };

export const Route = createFileRoute("/library")({
  component: LibraryPage,
});

function LibraryPage() {
  if (!getToken()) return <Navigate to="/login" />;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["books"],
    queryFn: () => listBooks(),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBook,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
    onError: (err: Error) => toast(err.message, "error"),
  });

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "epub" && ext !== "pdf") {
      toast("Only .epub and .pdf files are supported", "error");
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      toast("File is too large (max 500 MB)", "error");
      return;
    }
    setUploading(true);
    try {
      await uploadBook(file);
      await queryClient.invalidateQueries({ queryKey: ["books"] });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }, [queryClient]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) handleFile(file);
  }

  if (isLoading) return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" />
    </div>
  );
  if (error) return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
      <p className="text-red-600">{error.message}</p>
      <button onClick={() => queryClient.invalidateQueries({ queryKey: ["books"] })} className="rounded-md border px-3 py-1 text-sm text-gray-600 hover:bg-gray-50">Retry</button>
    </div>
  );

  const books = (data?.books ?? []) as BookWithProgress[];

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`relative min-h-[60vh] transition-colors ${dragOver ? "bg-blue-50" : ""}`}
    >
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/80">
          <p className="text-lg font-medium text-blue-600">Drop to upload</p>
        </div>
      ) : null}

      {uploading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
          <p className="text-gray-600">Uploading...</p>
        </div>
      ) : null}

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Library</h1>
        <Link
          to="/upload"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800"
        >
          Upload Book
        </Link>
      </div>

      {books.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-gray-500">No books yet. Drag an EPUB or PDF here.</p>
          <Link to="/upload" className="mt-2 inline-block text-sm font-medium text-gray-900 hover:underline">
            Or click to upload
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onDelete={() => deleteMutation.mutate(book.id)}
              isDeleting={deleteMutation.isPending && deleteMutation.variables === book.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BookCard({
  book,
  onDelete,
  isDeleting,
}: {
  book: BookWithProgress;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <div className={`group relative overflow-hidden rounded-lg border bg-white ${isDeleting ? "opacity-50 pointer-events-none" : ""}`}>
      <Link to="/book/$bookId" params={{ bookId: book.id }} className="block">
        <div className="aspect-[2/3] bg-gray-100">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt={book.title ?? "Book cover"}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-gray-400">
              {book.title ?? "Untitled"}
            </div>
          )}
        </div>
      </Link>
      <div className="p-2">
        <p className="truncate text-sm font-medium" title={book.title ?? undefined}>
          {book.title ?? "Untitled"}
        </p>
        <p className="truncate text-xs text-gray-500" title={book.author ?? undefined}>
          {book.author ?? "Unknown author"}
        </p>
        <div className="mt-1 flex items-center justify-between">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500">
            {book.format ?? "epub"}
          </span>
          {book.progressPct && book.progressPct > 0 ? (
            <span className="text-[10px] text-gray-400">{book.progressPct}%</span>
          ) : null}
          <button
            onClick={(e) => {
              e.preventDefault();
              if (confirm("Delete this book?")) onDelete();
            }}
            disabled={isDeleting}
            className="text-xs text-red-400 opacity-0 hover:text-red-600 group-hover:opacity-100 disabled:opacity-50"
            aria-label={`Delete ${book.title ?? "book"}`}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
