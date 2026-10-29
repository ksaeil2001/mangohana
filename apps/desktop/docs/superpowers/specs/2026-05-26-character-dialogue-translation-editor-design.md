# Personal Character Dialogue Translation Editor Design

## Product Goal

Build a Windows-only personal desktop app for translating Japanese and English adult comic or anime dialogue into Korean. The first version focuses on a strong local editing workflow: import messy txt files, normalize them into dialogue rows, let the user correct parsing mistakes, edit translations in three columns, and save project data reliably.

AI translation is intentionally deferred. The data model and UI reserve an AI translation field so a translation engine can be added later without changing the project format.

## MVP Scope

Included in the MVP:

- Free-form txt import and automatic normalization.
- Extraction of speaker, position, dialogue type, source text, and reference translation where possible.
- Manual correction of parsed fields.
- Character information entry per project.
- Three-column editing: source text, AI translation draft, user translation.
- Saving and loading user edits.
- Project-level storage for source lines, translations, characters, dictionary terms, and settings.
- Secret project mode with encrypted local storage.

Excluded from the MVP:

- Image OCR.
- Speech bubble detection.
- Korean typesetting on images.
- Anime speech recognition.
- SRT or ASS subtitle generation.
- Sound effect translation.
- Account, login, payment, server, or cloud features.

## Chosen Approach

Use an editor-first pipeline:

1. Import txt.
2. Automatically normalize txt into structured dialogue rows.
3. Show parser confidence and warnings.
4. Let the user quickly fix misclassified fields.
5. Edit translations in a three-column table.
6. Save the complete project locally.

This approach keeps the product centered on the user's first useful workflow. The parser is important, but it acts as a draft generator inside the editor rather than becoming a separate parser workbench. Project storage and encryption are part of the foundation, but they should not delay the core import-edit-save experience.

## Platform

Use Electron and React.

Electron main process responsibilities:

- Open and save local project files.
- Import txt files from disk.
- Run local project serialization and deserialization.
- Encrypt and decrypt secret project files.
- Expose a narrow IPC API to the renderer.
- Host future translation adapters.

React renderer responsibilities:

- Project dashboard and import flow.
- Dialogue table and row detail editing.
- Character editor.
- Dictionary editor.
- Settings and secret project prompts.

The app is local-only. No server, account system, telemetry, or cloud sync is required.

## Core Data Model

```ts
type DialogueType = "speech" | "thought" | "narration" | "unknown";
type SourceLanguage = "ja" | "en" | "mixed" | "unknown";

type DialogueLine = {
  id: string;
  order: number;
  speaker?: string;
  position?: string;
  dialogueType: DialogueType;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  referenceTranslation?: string;
  aiTranslation?: string;
  userTranslation?: string;
  notes?: string;
  parseConfidence: number;
  parseWarnings: string[];
};

type CharacterProfile = {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
};

type DictionaryTerm = {
  id: string;
  source: string;
  target: string;
  note?: string;
};

type TranslationProject = {
  schemaVersion: number;
  metadata: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    secret: boolean;
  };
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  dialogueLines: DialogueLine[];
  settings: {
    defaultSourceLanguage: SourceLanguage;
  };
};
```

The project payload is JSON before encryption. Secret projects encrypt the whole payload, not individual fields.

## Txt Normalization

The txt parser should be deterministic in the MVP. It should not call an AI service. This keeps import fast, repeatable, private, and easy to test.

The parser processes input in stages:

1. Normalize line endings and trim non-meaningful whitespace.
2. Split the input into candidate blocks using blank lines, numbering, bracketed labels, and dialogue-like separators.
3. Detect structured hints such as speaker labels, positions, dialogue type markers, language labels, and reference translation markers.
4. Merge continuation lines when a line appears to belong to the previous dialogue block.
5. Produce `DialogueLine` rows with confidence and warnings.

Patterns to recognize early:

- `Speaker: dialogue`
- `Speaker - dialogue`
- `[thought]`, `[monologue]`, `[narration]`, and equivalent Korean labels for thought or monologue.
- Position hints such as `(top left)`, `(bottom)`, and equivalent Korean position labels.
- Language labels such as `JP:`, `JA:`, `EN:`, `KR:`, `reference:`, and equivalent Korean reference labels.

Ambiguous content should remain editable rather than blocked. A parser warning is preferable to dropping text.

## Editing UX

The main editor should be dense and work-focused.

Primary layout:

- Left panel: dialogue list, search, filters, warning filters, and import status.
- Center: three-column table for source text, AI translation, and user translation.
- Right panel: selected row details including speaker, position, dialogue type, source language, reference translation, notes, confidence, and warnings.

The AI translation column exists in the MVP but can be empty or marked as unavailable until translation support is implemented. The user translation column is the authoritative edited output.

Parsing mistakes must be quick to repair. Low-confidence rows and rows with warnings should be visually scannable and filterable.

## Character And Dictionary Editing

Character profiles live inside each project. They include names, aliases, relationship notes, and speech style notes. In the MVP these fields help organize future translation context even before AI translation is implemented.

Dictionary terms also live inside each project. A term maps a source word or phrase to a preferred Korean expression with an optional note. Reuse across projects is an expansion feature, not an MVP requirement.

## Secret Project Storage

Secret project mode saves the same project payload with encryption enabled. The user provides a password when creating or opening a secret project. The app derives an encryption key from the password and encrypts the entire serialized project payload.

Requirements:

- Decryption happens only after the user provides the password.
- If the password is forgotten, the project cannot be recovered.
- Secret project paths should not be written into a recent-files list in the MVP.
- Save failures must not corrupt the previous saved file.

The renderer should never perform direct filesystem access. File operations and encryption stay in the Electron main process.

## Error Handling

Txt import:

- Preserve all meaningful input text.
- Convert uncertain parsing results into warnings.
- Let users edit warnings by correcting row fields.

Saving:

- Write to a temporary file and replace the target only after the write succeeds.
- Show a clear error if saving fails.
- Keep the in-memory project open after a save failure.

Secret project opening:

- Distinguish wrong password from malformed or corrupted project file when possible.
- Do not partially load a project after decryption or validation failure.

## Testing Strategy

Parser tests:

- Unit test representative txt samples with mixed Japanese, English, Korean notes, speaker labels, position hints, monologue markers, and reference translations.
- Assert that source text is never lost.
- Assert confidence and warnings for ambiguous input.

Storage tests:

- Save and load a normal project.
- Save and load a secret project with the correct password.
- Fail to open a secret project with the wrong password.
- Reject malformed project data.

UI tests:

- Import txt.
- Correct a parsed row.
- Edit user translation.
- Save and reopen the project.

## Future Expansion

Planned future features:

- AI translation using scene context, character profiles, dictionary terms, and dialogue order.
- Work-level character and term reuse across projects.
- OCR for manga images.
- Speech bubble detection.
- Korean text placement on images.
- Anime speech recognition.
- SRT and ASS subtitle export.

These features should be added behind stable project data boundaries so the MVP project files remain forward-compatible.
