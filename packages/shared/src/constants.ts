export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;

export const DEFAULT_LOOKUP_PROVIDERS = [
  {
    name: "Google",
    icon: "🔍",
    urlTemplate: "https://www.google.com/search?q={{query}}",
    sortOrder: 0,
    isBuiltin: true,
  },
  {
    name: "Wikipedia",
    icon: "📖",
    urlTemplate: "https://en.wikipedia.org/wiki/Special:Search?search={{query}}",
    sortOrder: 1,
    isBuiltin: true,
  },
  {
    name: "Translate",
    icon: "🌐",
    urlTemplate: "https://translate.google.com/?sl=auto&tl=en&text={{query}}",
    sortOrder: 2,
    isBuiltin: true,
  },
  {
    name: "Dictionary",
    icon: "📕",
    urlTemplate: "https://www.merriam-webster.com/dictionary/{{query}}",
    sortOrder: 3,
    isBuiltin: true,
  },
] as const;

export const MAX_UPLOAD_SIZE_MB = 500;
export const DEFAULT_STORAGE_QUOTA_MB = 1024;
export const PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes

export const TTS_ENGINES = ["chatterbox", "chatterbox-turbo", "kokoro"] as const;
export const TTS_DEFAULT_ENGINE = "chatterbox-turbo";
