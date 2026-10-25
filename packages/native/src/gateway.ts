import type {NativeFacade} from './facade.js';
export {NativeJobError} from './dto.js';

export type NativeTargetKind='UPLOAD'|'RESTORE'|'RASTER'|'EXPORT'|'LIBRARY'|'EXECUTION'|'REQUEST_CHECKPOINT';
export type NativeOwnerCapture={contextId:string|null;contextGeneration:string|null;ownerSessionId:string|null;ownerTabId:string|null;ownerRevision:string|null;workspaceRevision:string|null};
export type NativeParentClaim={generation:string;ownerId:string;workItemId:string|null};
// This immutable parent reference is private. It is never a child input or a
// public stage/receipt DTO, and stageInputDigest is the original StageInput hash.
export type NativeSourceInputRef={executionId:string;inputEvidenceId:string;stageInputDigest:string};
export type NativeTarget={accountId:string;targetKind:NativeTargetKind;targetId:string;semanticCaptureDigest:string;protectedOwnerCapture:NativeOwnerCapture;claim:NativeParentClaim;sourceInput?:NativeSourceInputRef};

// A facade is bound per immutable owning operation. This avoids a shared mutable
// "current account/job" across simultaneous API or worker calls.
export interface NativeGateway {
  forTarget(target:NativeTarget):NativeFacade;
  stopClaims():void;
  idle():Promise<void>;
  maintenance?(accountId:string):Promise<void>;
}
