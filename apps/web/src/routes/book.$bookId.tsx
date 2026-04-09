import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getBook, getToken } from "@/lib/api";

export const Route = createFileRoute("/book/$bookId")({
  component: BookDetailPage,
});

function BookDetailPage() {
  if (!getToken()) return <Navigate to="/login" />;
  const { bookId } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => getBook(bookId),
  });

  if (isLoading) return <p className="text-gray-500">Loading...</p>;
  if (error) return <p className="text-red-600">{error.message}</p>;

  const book = data?.book;
  if (!book) return <p className="text-red-600">Book not found</p>;

  return (
    <div>
      <Link to="/library" className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900">
        &larr; Back to Library
      </Link>

      <div className="flex gap-8">
        <div className="w-48 flex-shrink-0">
          <div className="aspect-[2/3] overflow-hidden rounded-lg bg-gray-100">
            {book.coverUrl ? (
              <img
                src={book.coverUrl}
                alt={book.title ?? "Book cover"}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">
                No cover
              </div>
            )}
          </div>
        </div>

        <div className="flex-1">
          <h1 className="text-2xl font-bold">{book.title ?? "Untitled"}</h1>
          <p className="mt-1 text-gray-600">{book.author ?? "Unknown author"}</p>

          <div className="mt-4 space-y-2 text-sm text-gray-500">
            <p>Format: {book.format?.toUpperCase()}</p>
            {book.language ? <p>Language: {book.language}</p> : null}
            {book.fileSize ? (
              <p>Size: {(book.fileSize / (1024 * 1024)).toFixed(1)} MB</p>
            ) : null}
            {book.totalChapters ? <p>Chapters: {book.totalChapters}</p> : null}
          </div>

          <div className="mt-6 flex gap-3">
            <Link
              to="/reader/$bookId"
              params={{ bookId }}
              className="inline-block rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800"
            >
              Read
            </Link>
            {book.downloadUrl ? (
              <a
                href={book.downloadUrl}
                className="inline-block rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                download
              >
                Download
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
