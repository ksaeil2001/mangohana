import type { PreparedPageImage, TranslationMode } from "../shared/projectTypes.js";
import { dedupePageFiles, movePageFile, naturalSortPageFiles } from "../shared/pageImageSelection.js";

export type ProjectSetupState = {
  files: PreparedPageImage[];
  mode: TranslationMode;
  duplicateCount: number;
  isPreparing: boolean;
  creationCheckpoint: "draft" | "initial-saved";
};

export type ProjectSetupAction =
  | { type: "picker-files-added"; files: PreparedPageImage[] }
  | { type: "dropped-files-added"; files: PreparedPageImage[] }
  | { type: "auto-sorted" }
  | { type: "file-moved"; id: string; destinationIndex: number }
  | { type: "file-removed"; id: string }
  | { type: "mode-changed"; mode: TranslationMode }
  | { type: "preparation-changed"; isPreparing: boolean }
  | { type: "creation-checkpoint-changed"; checkpoint: "draft" | "initial-saved" }
  | { type: "duplicates-dismissed" }
  | { type: "reset" };

export const initialProjectSetupState: ProjectSetupState = {
  files: [],
  mode: "precise",
  duplicateCount: 0,
  isPreparing: false,
  creationCheckpoint: "draft"
};

export function projectSetupReducer(
  state: ProjectSetupState,
  action: ProjectSetupAction
): ProjectSetupState {
  switch (action.type) {
    case "picker-files-added":
      return addFiles(state, action.files, state.files.length === 0);
    case "dropped-files-added":
      return addFiles(state, action.files, false);
    case "auto-sorted":
      return { ...state, files: naturalSortPageFiles(state.files) };
    case "file-moved":
      return { ...state, files: movePageFile(state.files, action.id, action.destinationIndex) };
    case "file-removed":
      return { ...state, files: state.files.filter((file) => file.id !== action.id) };
    case "mode-changed":
      return { ...state, mode: action.mode };
    case "preparation-changed":
      return { ...state, isPreparing: action.isPreparing };
    case "creation-checkpoint-changed":
      return { ...state, creationCheckpoint: action.checkpoint };
    case "duplicates-dismissed":
      return { ...state, duplicateCount: 0 };
    case "reset":
      return initialProjectSetupState;
  }
}

export function canConfirmProjectSetup(state: ProjectSetupState): boolean {
  return state.files.length > 0 && !state.isPreparing;
}

function addFiles(
  state: ProjectSetupState,
  incomingFiles: PreparedPageImage[],
  shouldNaturalSort: boolean
): ProjectSetupState {
  const combinedFiles = [...state.files, ...incomingFiles];
  const idUniqueFiles = combinedFiles.filter(
    (file, index) => combinedFiles.findIndex((candidate) => candidate.id === file.id) === index
  );
  const { files } = dedupePageFiles(idUniqueFiles);
  const duplicateCount = combinedFiles.length - files.length;

  return {
    ...state,
    files: shouldNaturalSort ? naturalSortPageFiles(files) : files,
    duplicateCount: state.duplicateCount + duplicateCount
  };
}
