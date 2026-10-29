# Context-aware inpainting design

## Goal

Add a personal-use inpainting tool to the desktop dialogue translation editor so the user can remove source text from page images before placing translated text. The first version focuses on manual control: the user paints the exact area to edit and chooses the context mode for that area.

## Scope

Included in the first version:

- A single inpainting tool in the page image panel.
- Manual brush mask editing over the current page image.
- Eraser and clear-mask controls.
- One mode selector with three presets:
  - Speech bubble text.
  - Caption or narration box text.
  - Text directly on the background.
- One generated result per run.
- Original image preservation.
- Result saved as a new page image asset and applied to the current page.
- Project marked dirty after a successful result.

Excluded from the first version:

- Automatic OCR.
- Automatic speech bubble or text-region detection.
- Decorative SFX / large lettering handling.
- Multiple result candidates.
- Multiple mask regions processed as separate jobs.
- Translation text placement or typesetting.
- Secure credential storage.

## User workflow

1. The user opens or saves a project and connects a page image.
2. In the page image panel, the user clicks `Inpaint`.
3. The image switches into edit mode with a canvas mask overlay.
4. The user paints over the source text to remove.
5. The user chooses one preset:
   - `Speech bubble`: preserve the bubble outline and fill while removing only text.
   - `Caption box`: preserve rectangular box edges and fill while removing only text.
   - `Background text`: reconstruct nearby art, texture, gradients, and linework without adding new text.
6. The user clicks `Run`.
7. The main process sends the original image, mask PNG, and preset prompt to the image edit API.
8. The result image is written as a new asset file.
9. The current page image metadata points to the new asset.
10. The project becomes dirty. The user saves the project to persist the metadata update.

## Preset behavior

All modes use the same underlying operation: image edit with a source image, a PNG mask, and a prompt. The difference is in prompt text and mask handling.

### Speech bubble

Use this when the source text sits inside a clean speech bubble. The prompt should ask the model to remove only the text, preserve the bubble border, preserve the white or toned fill, and avoid adding any lettering.

Mask behavior: keep the mask close to the painted text, with a small expansion to cover antialiasing and text shadows.

### Caption box

Use this when the source text sits inside a rectangular narration or caption box. The prompt should ask the model to remove only the text while preserving the box boundary, fill color, screen tone, and rectangular shape.

Mask behavior: use the tightest expansion. The user should not need to mask the box border unless the text overlaps it.

### Background text

Use this when the source text is printed directly over scenery, clothing, signs, texture, gradients, or character art. The prompt should ask the model to reconstruct the underlying background and avoid generating new text, symbols, or captions.

Mask behavior: allow a slightly larger expansion so the model has enough room to blend the repaired art.

## Renderer design

`PageImagePanel` remains the visual home for image work. It gains an inpainting edit mode rather than a separate page.

Key UI elements:

- `Inpaint` button next to Reconnect/Fit/100%.
- Preset segmented control: Speech bubble, Caption box, Background text.
- Brush size control.
- Brush / eraser toggle.
- Clear mask button.
- Cancel button.
- Run button.
- Busy state while the API request is running.
- Error message when the request fails.

The mask editor uses an HTML canvas positioned over the rendered image. Pointer coordinates are translated from displayed image coordinates back to natural image coordinates so the mask aligns with the original source pixels. The saved mask is a PNG at the original image dimensions.

## Main-process design

Add an IPC handler, tentatively `project:inpaintPageImage`.

Input:

- `projectFilePath`
- current page image metadata
- mask PNG bytes or a temporary mask file
- selected preset
- optional user prompt override

Output:

- updated `PageImage` metadata for the newly generated image
- stored relative path for the result

The main process resolves the current page image path from `projectFilePath` and `storedRelativePath`, validates that it stays inside the project directory, calls the image edit API, writes the returned PNG into the project assets image folder, computes hash and metadata, and returns the new `PageImage`.

The first version reads `OPENAI_API_KEY` from the process environment. No credential UI, encryption, or key persistence is included.

## File storage design

Original images are never overwritten. Result files use a predictable suffix such as:

```text
page-001-inpaint-001.png
page-001-inpaint-002.png
```

The app replaces the current page's `pageImages` entry with the returned metadata. Older original and prior result files remain in the assets folder. This keeps rollback possible later without building rollback UI in the first version.

## Error handling

- If no current page image exists, disable `Inpaint`.
- If no mask pixels are painted, disable `Run`.
- If `OPENAI_API_KEY` is missing, show a clear setup message.
- If the image edit API fails, keep the original image active and show the error.
- If saving the result file fails, keep the original image active and show the error.
- If the returned image cannot be rendered, keep the metadata unchanged.

## Testing

Renderer tests:

- Inpaint button is disabled without a connected image.
- Inpaint edit mode opens for a connected image.
- Preset selection changes the request mode.
- Run is disabled until a mask exists.
- Successful IPC result replaces the current page image metadata and marks the project dirty.
- Cancel leaves the image unchanged.

Main-process tests:

- Input validation rejects paths outside the project directory.
- Missing API key returns a useful error.
- Result image bytes are written to a new asset file without overwriting the original.
- Returned metadata has correct page number, stored relative path, MIME type, byte size, and SHA-256.

Manual QA:

- Speech bubble text removal.
- Caption box text removal.
- Background text removal.
- Cancel and failure paths.
- Save/reopen after successful inpainting.

## Implementation notes

Avoid adding an SDK dependency in the first version. Use the platform `fetch`, `FormData`, and file APIs available in the Electron main process. If that proves unreliable in this Electron runtime, the fallback is to add the official OpenAI SDK after explicit approval.

The first version should not try to solve OCR or translated text placement. It prepares clean image regions only.

## Self-review

- No placeholders remain.
- The first version has one clear workflow and three explicit context modes.
- Original preservation, one-result generation, and manual mode selection match the approved decisions.
- Security-related features are intentionally excluded because this is a personal-use MVP.
- The design keeps implementation scoped to existing renderer, IPC, and image asset patterns.
