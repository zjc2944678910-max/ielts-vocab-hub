# Design QA — Custom background glass surfaces

## Scope and evidence

- Settings, dictation, paraphrase, review, lookup, and assistant surfaces when a custom background is enabled
- Six-page evidence: `output/playwright/glass-settings-final.png`, `glass-dictation-final.png`, `glass-paraphrase-final.png`, `glass-flashcards-final.png`, `glass-lookup-final.png`, and `glass-assistant-final.png`
- Fully transparent lookup source strip: `output/playwright/transparent-dictionary-source-final.png`
- Fully transparent assistant footer with a light input glass: `output/playwright/transparent-chat-composer-final.png`

## Result

passed — primary panels use a 34% dark glass layer; the two requested surrounding strips are transparent, while inputs retain enough contrast.

---

# Design QA — Audio controls

## Scope

- Lookup pronunciation button
- Dictation/review playback button
- Dictation navigation icon
- Desktop and narrow viewport integration

## Reference and implementation evidence

- Shape reference: `/var/folders/3k/dkt__2v56jj25n3rv0cv7f740000gn/T/TemporaryItems/NSIRD_screencaptureui_WlTkma/截屏2026-08-13 下午5.00.52.png`
- Existing-color reference: `/var/folders/3k/dkt__2v56jj25n3rv0cv7f740000gn/T/TemporaryItems/NSIRD_screencaptureui_mIDyZc/截屏2026-08-13 下午4.59.58.png`
- Focused side-by-side comparison: `output/playwright/audio-button-reference-comparison.png`
- Lookup integration: `output/playwright/audio-button-lookup.png`
- Training integration: `output/playwright/audio-button-training.png`
- Active navigation state: `output/playwright/audio-button-sidebar-active.png`
- Narrow viewport: `output/playwright/audio-button-mobile.png`

The supplied target is a component crop rather than a full-screen mockup, so full-view comparison is limited to checking the implemented controls in their actual page contexts. Per the user's clarification, the reference supplies the circular waveform treatment only; the product's mint, dark, gray, and active-state colors remain authoritative.

## Visual evaluation

| Area | Result | Notes |
| --- | --- | --- |
| Hierarchy | Pass | Lookup control remains secondary to the word; the larger training control remains the primary action. |
| Color | Pass | Existing mint/dark palette is retained. Navigation remains gray when inactive and mint when active. |
| Typography | Pass | Existing labels and type scale are unchanged; the large control label remains legible. |
| Spacing | Pass | Circular controls are centered and do not collide with adjacent actions or content. |
| Responsiveness | Pass | Lookup and navigation controls remain aligned in the narrow viewport. |
| Icon consistency | Pass | All pronunciation/playback surfaces use the same rounded waveform asset; no half-circle glyph remains. |
| Accessibility | Pass | Buttons keep descriptive labels, focus styling, and non-semantic image alternatives. |

## Interaction verification

- Playback controls remain clickable.
- Training replay count updates after replay.
- Active and inactive navigation states render with distinct existing colors.
- Browser checks completed without unhandled console errors.

## Final result

passed

---

# Design QA — Full-canvas theme and crop workflow

## Scope

- Custom background continuity beneath the top bar and sidebar
- Bottom-aligned desktop profile identity
- Top-bar daily progress beside the reset action
- User-controlled avatar/background cropping with drag and zoom

## Evidence

- Final desktop layout: `output/playwright/full-bleed-profile-layout-final.png`
- Avatar crop drag/zoom: `output/playwright/avatar-cropper-drag-zoom.png`
- Background crop: `output/playwright/photo-cropper-background.png`
- Final 390 px viewport: `output/playwright/profile-layout-mobile-final.png`

## Visual evaluation

| Area | Result | Notes |
| --- | --- | --- |
| Background continuity | Pass | The same user photo remains visible beneath translucent top and side navigation surfaces. |
| Navigation hierarchy | Pass | Daily progress sits next to reset in the top bar; profile identity anchors the sidebar bottom. |
| Crop control | Pass | Avatar uses a circular safe-area guide; both photo types support drag and zoom before save. |
| Readability | Pass | Workspace surfaces retain dark contrast while allowing the personal background to remain visible. |
| Responsiveness | Pass | The daily ring remains in the mobile top bar and the crop dialog fits a 390 px viewport. |
| Data safety | Pass | Confirm-save was exercised through an intercepted upload; existing local avatar/background versions were unchanged. |

## Final result

passed

# Design QA — Personal profile and appearance

## Scope

- Personal display name and avatar preview
- Local background-photo preview with readability overlay
- Global button/accent color preview with automatic foreground contrast
- Sidebar identity on desktop and mobile

## Evidence

- Default desktop settings: `output/playwright/profile-settings-desktop.png`
- Custom blue color and name preview: `output/playwright/profile-settings-blue-preview.png`
- Avatar and background preview: `output/playwright/profile-background-preview.png`
- 390 px viewport: `output/playwright/profile-settings-mobile.png`

## Visual evaluation

| Area | Result | Notes |
| --- | --- | --- |
| Hierarchy | Pass | Personal identity, background, then button theme follow a clear editing order. |
| Color | Pass | User color is applied immediately; button text and waveform icons switch contrast automatically. |
| Background readability | Pass | The photo is rendered through an adjustable dark overlay and does not replace surface backgrounds. |
| Photo handling | Pass | Avatar uses a circular centered crop; background uses a landscape preview. |
| Responsiveness | Pass | Editors collapse to one column and retain usable touch targets at 390 px. |
| Accessibility | Pass | File controls, remove actions, color input, and preview controls have discernible names. |
| Privacy | Pass | Copy states that photos stay local; the browser compresses before upload. |

## Interaction verification

- Name and color update the sidebar and controls without a reload.
- Avatar and background files render as previews before save.
- Default settings reload without persisting unsaved browser previews.
- The settings API keeps default appearance values when no custom photos exist.
- Browser checks completed without unhandled console errors.

## Final result

passed

---

# Design QA — Five-source lookup

## Scope

- Source switch: Smart detection, Cambridge English–Chinese, Cambridge Chinese–English, local ECDICT, and AI translation
- Cambridge Chinese–English candidate results
- AI phrase/sentence translation results
- Desktop and 390 px viewport integration

## Evidence

- Desktop Cambridge Chinese–English: `output/playwright/lookup-five-sources-chinese.png`
- Desktop AI translation: `output/playwright/lookup-five-sources-ai.png`
- Mobile source switch: `output/playwright/lookup-five-sources-mobile.png`

## Visual evaluation

| Area | Result | Notes |
| --- | --- | --- |
| Hierarchy | Pass | One source switch controls one result surface; dictionary and AI provenance remain prominent. |
| Color | Pass | Existing dark/mint system is preserved, with the warm accent reserved for AI provenance. |
| Typography | Pass | Candidate expressions are primary, definitions and examples remain secondary. |
| Spacing | Pass | Candidate rows align with the existing sense-list rhythm without adding card clutter. |
| Responsiveness | Pass | All five sources remain directly visible by wrapping on the 390 px viewport. |
| Trust cues | Pass | Cambridge results link to their source; AI results are explicitly labeled and warn that they are generated. |
| Accessibility | Pass | Source controls, candidate links, and pronunciation controls have discernible names. |

## Interaction verification

- Chinese lookup returned five exact-heading Cambridge candidates without unrelated adjacent entries.
- Explicit AI phrase translation rendered a structured result.
- Clicking a source reruns the current query.
- Candidate pronunciation buttons remain operable.
- Browser console reported zero errors and zero warnings.

## Final result

passed
