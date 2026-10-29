export type GeminiApiKeySource = "none" | "environment" | "encrypted" | "session";
export type GeminiApiKeyPersistence = "encrypted" | "session-only" | "unavailable";

export type GeminiApiKeyStatus = {
  configured: boolean;
  source: GeminiApiKeySource;
  persistence: GeminiApiKeyPersistence;
  requiresReentry: boolean;
};
