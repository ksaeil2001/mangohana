import type {
  CharacterProfile,
  DialogueLine,
  DialogueLineV2,
  DialogueType,
  DialogueTypesetting,
  DictionaryTerm,
  LineStatus,
  PageProcessingRecord,
  PageImage,
  DerivedImageAsset,
  ProcessingQueueState,
  ProcessingRunRecord,
  SourceLanguage,
  TranslationProjectV2
} from "./projectTypes.js";

export type NewDialogueLineInput = {
  pageNumber: number;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  dialogueType: DialogueType;
  speaker?: string;
  position?: string;
  notes?: string;
  lineStatus?: LineStatus;
  referenceTranslation?: string;
  userTranslation?: string;
  typesetting?: DialogueTypesetting;
};

export type DialogueUserPatch = Partial<
  Pick<
    DialogueLine,
    | "speaker"
    | "position"
    | "dialogueType"
    | "lineStatus"
    | "sourceLanguage"
    | "sourceText"
    | "referenceTranslation"
    | "userTranslation"
    | "notes"
    | "typesetting"
    | "pageNumber"
  >
>;

export type ProjectMutation =
  | { type: "set_project_title"; title: string }
  | { type: "add_dialogue_line"; input: NewDialogueLineInput }
  | { type: "update_dialogue_line"; lineId: string; patch: DialogueUserPatch }
  | { type: "update_dialogue_typesetting"; lineId: string; typesetting: DialogueTypesetting }
  | { type: "remove_dialogue_line"; lineId: string }
  | { type: "reorder_dialogue_lines"; orderedLineIds: string[] }
  | { type: "upsert_character"; character: CharacterProfile }
  | { type: "remove_character"; characterId: string }
  | { type: "upsert_dictionary_term"; term: DictionaryTerm }
  | { type: "remove_dictionary_term"; termId: string }
  | { type: "remove_page_image"; pageImageId: string }
  | {
      type: "update_project_settings";
      patch: Partial<TranslationProjectV2["settings"]>;
    };

export type NormalizedProjectMutation =
  | Exclude<ProjectMutation, { type: "add_dialogue_line" }>
  | { type: "add_dialogue_line"; line: DialogueLineV2 }
  | { type: "register_page_images"; pageImages: PageImage[] };

export type PendingUserMutation = {
  mutationId: string;
  acceptedRevision: number;
  mutation: NormalizedProjectMutation;
  changedPaths: string[];
  createdAt: string;
};

export type RevisionJournalEntry = {
  revision: number;
  owner: "user" | "main";
  changedPaths: string[];
  createdAt: string;
};

export type ProjectSessionStatus = "active" | "needs_recovery" | "closing";

export type BatchDialogueUpdate = {
  id: string;
  aiTranslation?: string;
  typesetting?: DialogueTypesetting;
  lineStatus?: LineStatus;
  expectedTranslationFingerprint?: string;
  expectedTypesettingFingerprint?: string;
  stylePreset?: string;
};

export type MainProjectPatch =
  | {
      type: "commit_processing_run";
      run: ProcessingRunRecord;
      pageRecord: PageProcessingRecord;
      assets: DerivedImageAsset[];
    }
  | {
      type: "merge_pipeline_dialogues";
      pageImageId: string;
      lines: DialogueLineV2[];
      orphanedPersistentRegionIds: string[];
    }
  | {
      type: "approve_asset";
      pageImageId: string;
      assetId: string;
      kind: "cleaned" | "translated";
    }
  | {
      type: "update_processing_queue";
      queue: ProcessingQueueState;
      expectedQueueId?: string;
      expectedQueueToken?: string;
    }
  | {
      type: "commit_batch_result";
      baseRevision?: number;
      speechStylePreset?: string;
      dialogueUpdates: BatchDialogueUpdate[];
      queue?: ProcessingQueueState;
      expectedQueueId?: string;
      expectedQueueToken?: string;
    };
