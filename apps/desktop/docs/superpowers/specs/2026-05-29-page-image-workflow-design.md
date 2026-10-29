# Page-Based Comic Translation Workflow Design

## Product Goal

Add a page-centered workflow for comic translation. The editor should let the user translate one comic page at a time, with the page image visible beside the dialogue rows for that page. This keeps translation decisions grounded in panel order, facial expressions, narration placement, and page-level emotional flow.

This design keeps OCR, speech bubble detection, and image typesetting out of scope. The first version treats images as reference material matched to page numbers.

## Chosen Direction

Use a page navigation workflow with a left/right split:

1. Import txt.
2. Detect page separators and assign `pageNumber` to dialogue lines.
3. Upload page images.
4. Copy images into a project asset folder without re-encoding.
5. Verify each copy with SHA-256.
6. Match images to pages by upload order.
7. Show the current page image on the left and only that page's dialogue rows on the right.
8. Move through pages with previous/next controls.

This follows the existing editor-first product direction. The parser still creates a structured draft, and the user can correct mistakes directly in the editor.

## Scope

Included:

- Automatic page separator detection during txt import.
- Manual page number editing for each dialogue line.
- Current-page navigation with previous and next controls.
- Page-level counts: dialogue count, completed count, and review-needed count.
- Multi-image upload.
- Image-to-page matching by selected file order.
- Image-based page expansion when more images exist than txt pages.
- Project asset folder image storage.
- Byte-preserving image copies.
- SHA-256 verification for original and copied image files.
- Left/right split page editing layout.
- Missing-image and no-dialogue page states.

Excluded:

- OCR.
- Speech bubble detection.
- Automatic visual matching between text and bubbles.
- Korean text insertion on images.
- Image compression, resizing, re-encoding, or format conversion.
- Page thumbnail grid.
- Drag-and-drop page reordering.
- Secret-project image encryption.

Secret-project image encryption should be designed separately. Until encrypted asset storage exists, image upload is disabled for secret projects. This avoids creating unencrypted image copies beside an encrypted `.ctp` file.

## Data Model

Extend dialogue lines with page numbers:

```ts
type DialogueLine = {
  id: string;
  order: number;
  pageNumber: number;
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
```

Add page image metadata to the project:

```ts
type PageImage = {
  id: string;
  pageNumber: number;
  storedRelativePath: string;
  originalFileName: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  copiedAt: string;
};

type TranslationProject = {
  schemaVersion: number;
  metadata: ProjectMetadata;
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  dialogueLines: DialogueLine[];
  pageImages: PageImage[];
  settings: {
    defaultSourceLanguage: SourceLanguage;
  };
};
```

The project should derive its page count as:

```ts
max(
  highest dialogueLine.pageNumber,
  highest pageImage.pageNumber,
  1
)
```

This means image uploads can create pages even when those pages have no dialogue yet.

## Txt Page Detection

The parser should detect common page separators, including:

- `--- page 1 ---`
- `page 1`
- `Page 1`
- `p.1`
- `[p.1]`
- `[page 1]`
- `페이지 1`
- `1페이지`

When a page marker appears, following dialogue blocks inherit that page number until another marker appears.

If no page marker exists, imported lines default to page `1`.

If page markers are malformed or decrease unexpectedly, the parser should keep importing and add parser warnings. It should not reject the whole file.

## Manual Page Correction

Each dialogue row should expose an editable page number field. Changing it should:

- Move the row out of the current page view if the new page differs.
- Preserve global `order`.
- Mark the project dirty.
- Recalculate page counts and page status summaries.

The detail panel can also show the current line's page number, but the table row editor is the primary correction point.

## Image Upload And Storage

The upload flow:

1. User selects one or more image files.
2. The app assigns page numbers by selection order, starting at page `1`.
3. For each image, the app copies the original file bytes into a project asset folder.
4. The app calculates SHA-256 for the original file.
5. The app calculates SHA-256 for the copied file.
6. If hashes match, the image is registered in `pageImages`.
7. If hashes differ, the copied file is deleted and the image is not registered.

Supported initial image extensions:

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`

The app must not resize, recompress, re-encode, or strip metadata during this copy step. Display scaling in the UI is allowed because it does not alter the stored file.

## Project Asset Folder

When a project is saved at:

```text
ExampleProject.ctp
```

image files should live under:

```text
ExampleProject-assets/images/
```

Suggested stored names:

```text
page-001.jpg
page-002.png
page-003.webp
```

If the same page is assigned again, create a collision-free file name such as:

```text
page-001-2.jpg
```

The project stores relative asset paths so a project file and its asset folder can be moved together.

## Page Expansion Rules

If txt detects 3 pages and the user uploads 5 images:

- Project page count becomes 5.
- Pages 1-3 may have dialogue and images.
- Pages 4-5 have images and no dialogue.
- The page editor shows an empty dialogue state for pages 4-5.

If txt detects 6 pages and the user uploads 4 images:

- Project page count remains 6.
- Pages 1-4 have images and dialogue.
- Pages 5-6 have dialogue and no image.
- The image panel shows a missing-image state for pages 5-6.

## Left/Right Page Editing Layout

The main table area should become a page workspace:

```text
left: current page image
right: current page dialogue editor
```

The right side should keep the existing three-column editing model:

- source text
- AI translation
- user edit

The current page controls should include:

- previous page
- next page
- current page number
- total page count
- current page dialogue count
- current page completed count
- current page review-needed count

The existing search, speaker filter, status filter, and issue filter should apply within the current page unless a future global search mode is explicitly added.

## Error Handling

Image copy failure:

- Show an error message.
- Do not register the image.
- Continue processing the remaining selected images.

Hash mismatch:

- Delete the copied file.
- Show "이미지 복사 검증에 실패했습니다."
- Do not register the image.

Unsupported file extension:

- Skip the file.
- Show a warning that only jpg, jpeg, png, and webp are supported.

Missing asset on project open:

- Keep the `PageImage` metadata.
- Show a missing-file state in the image panel.
- Add a project warning or status message.

Secret project:

- Disable image upload while `project.metadata.secret` is true.
- Show "시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다."
- Do not create or modify the asset folder.

## Testing

Parser tests:

- Detect English page markers.
- Detect Korean page markers.
- Default to page 1 when no marker exists.
- Add warnings for malformed page markers without rejecting import.

Storage tests:

- Copy image bytes into the asset folder.
- Verify matching SHA-256 hashes.
- Reject and clean up a copied file on hash mismatch.
- Preserve relative image paths in project data.

Renderer tests:

- Navigate previous and next pages.
- Show only the current page's dialogue lines.
- Move a line to another page by editing its page number.
- Show missing-image and no-dialogue states.
- Expand page count when uploaded images exceed txt pages.

IPC tests:

- Validate image upload file extension handling.
- Return registered `PageImage` metadata after successful upload.
- Return per-file failures without aborting the entire batch.

## Rollout Plan

Build this in small slices:

1. Add `pageNumber` to dialogue lines and parser output.
2. Add page navigation over text-only data.
3. Add editable page number fields.
4. Add page image metadata and image copy/hash verification in the main process.
5. Add image upload IPC.
6. Add the left/right page workspace.
7. Add missing-image and no-dialogue states.

This order keeps the text editor usable at every step and avoids coupling page navigation to image upload too early.
