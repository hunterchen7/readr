import { createFileRoute, useNavigate, Navigate } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadBook, getToken } from "@/lib/api";

export const Route = createFileRoute("/upload")({
  component: UploadPage,
});

function UploadPage() {
  if (!getToken()) return <Navigate to="/login" />;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedFileName, setSelectedFileName] = useState("");
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
      setSelectedFileName(file.name);
      setUploading(true);
      setUploadProgress(0);

      // Simulate progress since uploadBook doesn't expose real progress
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) return prev;
          return prev + Math.random() * 15;
        });
      }, 300);

      try {
        await uploadBook(file);
        setUploadProgress(100);
        clearInterval(progressInterval);
        await queryClient.invalidateQueries({ queryKey: ["books"] });
        navigate({ to: "/library" });
      } catch (err) {
        clearInterval(progressInterval);
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        setSelectedFileName("");
        setUploadProgress(0);
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
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" />
            <p className="text-sm font-medium text-gray-700">{selectedFileName}</p>
            <div className="w-64">
              <div className="h-1.5 w-full rounded-full bg-gray-200">
                <div
                  className="h-1.5 rounded-full bg-gray-900 transition-all duration-300"
                  style={{ width: `${Math.round(uploadProgress)}%` }}
                />
              </div>
              <p className="mt-1 text-center text-xs text-gray-400">{Math.round(uploadProgress)}%</p>
            </div>
          </div>
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
