import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadBook } from "@/lib/api";

export const Route = createFileRoute("/upload")({
  component: UploadPage,
});

function UploadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext !== "epub" && ext !== "pdf") {
        setError("Only .epub and .pdf files are supported");
        return;
      }
      const MAX_SIZE_MB = 500;
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        setError(`File is too large (max ${MAX_SIZE_MB} MB)`);
        return;
      }

      setError("");
      setUploading(true);

      try {
        await uploadBook(file);
        await queryClient.invalidateQueries({ queryKey: ["books"] });
        navigate({ to: "/library" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [navigate, queryClient],
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    for (const file of Array.from(e.dataTransfer.files)) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    for (const file of Array.from(e.target.files ?? [])) handleFile(file);
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Upload Book</h1>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`rounded-lg border-2 border-dashed p-16 text-center transition-colors ${
          dragOver
            ? "border-gray-900 bg-gray-50"
            : "border-gray-300 hover:border-gray-400"
        }`}
      >
        {uploading ? (
          <p className="text-gray-500">Uploading...</p>
        ) : (
          <>
            <p className="mb-2 text-gray-600">
              Drag and drop EPUB or PDF files here
            </p>
            <p className="mb-4 text-sm text-gray-400">or</p>
            <label className="cursor-pointer rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800">
              Choose Files
              <input
                type="file"
                accept=".epub,.pdf"
                multiple
                onChange={handleFileInput}
                className="hidden"
              />
            </label>
          </>
        )}
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
