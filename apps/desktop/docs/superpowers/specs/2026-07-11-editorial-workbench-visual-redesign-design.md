# Editorial Workbench Visual Redesign

Date: 2026-07-11
Branch: `codex/editorial-workbench`

## Objective

Transform the translation editor from a mostly white utility interface into a distinctive editorial workbench while preserving every existing workflow and layout contract.

The product should read immediately as a professional image-and-dialogue editing tool: a deep navy application frame surrounding a warm paper-like workspace, with restrained semantic color marking OCR, speaker, translation, and completion states.

## Product Principles

1. **Editorial, not decorative.** Color establishes hierarchy and state; it does not become a dashboard mosaic.
2. **One visual anchor.** The image stage remains the strongest surface, framed by the dark application shell.
3. **Warm working surface.** Dialogue editing and guidance panels use ivory and cream rather than sterile white.
4. **Semantic color.** Each workflow stage receives a stable color that appears in the rail, active treatment, small status markers, and relevant actions.
5. **Long-session comfort.** Reading and editing contrast must remain calm and accessible for extended translation work.

## Color System

### Structural colors

- Application frame / top bar: deep navy `#14213D`
- Image stage: ink blue `#101827`
- Secondary dark surface: slate navy `#1B2A47`
- Main workspace: warm ivory `#F7F2E8`
- Primary panel: cream white `#FFFDF8`
- Secondary panel: parchment `#F1E8D8`
- Strong text: navy ink `#172033`
- Muted text: blue gray `#647083`
- Hairline: warm gray `#D8CDBB`

### Action and workflow colors

- Primary action / selection: teal `#168C86`
- Primary hover: deep teal `#0F6F6B`
- OCR stage: aqua blue `#2F80A8`
- Speaker stage: amber `#D39028`
- Translation stage: coral `#D7654F`
- Complete stage: emerald `#2E8B68`
- Warning: burnt orange `#B9662B`
- Destructive: brick red `#B83A32`

Color must never be the only state signal. Labels, icons/numbers, border treatment, and `aria-current` remain authoritative.

## Surface Hierarchy

### App frame

The top bar and left rail form one continuous navy frame. The brand title, file state, and navigation use light ink colors with teal as the active accent. This establishes identity before the user reads individual controls.

### Image workspace

The image canvas keeps its dark surround. Toolbars use slate navy rather than near-black, and important actions receive teal treatment. The image itself remains neutral and undistorted.

### Guided work panel

The panel uses a cream content surface with a parchment stage rail. The current stage is filled with its semantic color; completed stages use a restrained tinted background and colored number; upcoming stages remain neutral.

### Dialogue queue

The queue sits on warm ivory. The selected line receives a pale teal surface, teal keyline, and clear selection indicator. Neighboring lines remain quieter, using cream and muted ink. Full-table mode retains density while gaining the same hierarchy.

## Typography

- Product title, panel headings, stage names: strong editorial sans-serif weight, compact tracking.
- Body and editing fields: readable Korean-first sans-serif stack using available system fonts (`Pretendard`, `Noto Sans KR`, `Malgun Gothic`) without adding a package or remote dependency.
- Dialogue numbers, confidence values, keyboard shortcuts, and compact metrics: monospace stack.
- Headings must be visibly closer to their content than to the previous section.
- Utility copy remains concise; decorative marketing language is not introduced.

## Component Treatments

### Buttons

- Primary: solid teal with high-contrast text.
- Secondary: cream or navy-outline treatment depending on surface.
- Stage-specific actions may use the stage color only when the action advances that stage.
- Destructive actions remain brick red and visually separated.
- Focus rings use a high-contrast teal/cream double treatment on dark surfaces.

### Inputs and editors

- Warm-white fields on light surfaces with navy text.
- Dark OCR review cards retain light foregrounds and their existing contrast guarantees.
- Focus uses a teal border and subtle outer ring, not a generic blue browser-like glow.

### Workflow rail

- OCR: aqua.
- Speaker: amber.
- Translation: coral.
- Complete: emerald.
- Current step receives a filled marker and stronger label.
- Completed steps receive a colored marker with a pale tint.
- Compact mode visually hides descriptions while preserving them for assistive technology.

### OCR highlight

- Teal/aqua keyline with a translucent tint and readable stage label.
- Fit and actual-size image geometry must remain unchanged.

### Status and alerts

- Success uses emerald tint.
- Warning uses amber/burnt-orange tint.
- Error uses coral/brick tint.
- Global status remains visible in Pages and Settings and continues to use one effective live announcer.

## Interaction and Motion

- Stage changes: 140–180ms fade/translate transition.
- Row selection: short background and border transition.
- Button hover/focus: color and elevation transition under 140ms.
- `prefers-reduced-motion` disables nonessential transitions.
- No looping, decorative, or attention-seeking animation.

## Responsive Behavior

- Preserve the existing 1440, 1600, and 1920 desktop grid contracts.
- Preserve the 1100/1099 side-by-side-to-stacked boundary.
- Compact guidance must continue widening the image workspace.
- At narrower widths, semantic colors remain in stage markers and headers without increasing chrome or causing horizontal overflow.
- The visual redesign must not change DOM order, keyboard navigation, or responsive ownership of panels.

## Implementation Scope

### Expected primary file

- `src/renderer/styles.css`

### Allowed minimal supporting changes

- Add narrowly scoped class names or `data-*` attributes only when existing selectors cannot express a required stage or surface state.
- No component restructuring unless rendered verification proves CSS-only work cannot achieve the approved design.

### Explicitly out of scope

- OCR, speaker, translation, completion, queue, storage, IPC, and persistence behavior changes.
- Package additions or external font dependencies.
- Database/schema/authentication/deployment changes.
- Marketing pages or hosting work.

## Verification Matrix

Validate these rendered states:

1. Empty/new project.
2. Saved project with page image.
3. OCR review stage with active image highlight.
4. Speaker confirmation stage.
5. Translation editing stage.
6. Completed page with remaining work.
7. Project-complete state.
8. Queue and full-table views.
9. Guided and compact modes.
10. Inpainting inspector.

Validate at 1440×900, 1600×900, 1920×1080, and the 1099/1100 responsive boundary.

For each affected state:

- Capture before and after screenshots.
- Check horizontal overflow.
- Check browser/Electron console errors.
- Verify focus visibility and text contrast.
- Confirm OCR highlight geometry in fit and actual modes.

Run:

- `npm run typecheck`
- `npm test`
- `npm run build`

## Success Criteria

- The first viewport clearly shows a navy application frame, warm ivory workspace, and cream editorial panels.
- The current workflow stage is recognizable by color and label at a glance.
- The image remains the primary visual anchor.
- The interface no longer reads as a black-and-white admin tool.
- Color remains restrained enough for long translation sessions.
- Existing layout, functionality, accessibility semantics, and test suite remain intact.
