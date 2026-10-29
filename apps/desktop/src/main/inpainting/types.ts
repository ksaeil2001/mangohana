import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../shared/inpainting.js";

export type InpaintingEngineAvailability = {
  available: boolean;
  reason?: string;
};

export interface InpaintingEngine {
  readonly providerId: InpaintingProvider;
  readonly displayName: string;
  readonly isLocal: boolean;

  isAvailable(): Promise<InpaintingEngineAvailability>;
  inpaint(request: InpaintExecutionRequest): Promise<InpaintExecutionResult>;
}
