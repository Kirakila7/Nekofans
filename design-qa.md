# Main-agent memory explorer QA — 2026-11-04

final result: passed

Release-based integration verification: the memory feature was isolated on
v0.28.41 (20dde9291c35ee74b464679eb43a2a7234db6356), excluding unrelated local
configuration and account-relay work. 65 focused Node checks, 3 real service
component checks and 1 native FactStore recovery check pass. A local merge with
PR #62 at ad99e456e857912f423a0b6742ddd2152fc1149f runs 134 checks with 133 passes,
1 existing Windows /usr/bin/zip fixture failure and no skips. The same failure
is reproduced on the release baseline. Native Electron visual acceptance remains
unverified; browser fixtures and jsdom are not presented as native acceptance.

Latest navigation/name refinement: 鱼的记忆 is the consistent entry/page title.
The main desktop menu opens the star map directly. The workbench adds a matching
rail button immediately after community, using the same `neko-side-rail__button`
class and a locally bundled Lucide brain icon. Browser inspection of the actual
source fragment and canonical rail CSS confirmed both buttons at 40 × 40, stacked
at y=28/y=78. Clicking the new entry opened the star map. After selecting the list
and reloading, stars were selected by default; no universe wording remained.
The warning/error log was empty. Ten focused entry/menu/persona tests passed,
including reusing an existing memory window and its disposable stars-open event.
The entry fixture at `/workbench` isolates these controls; it does not claim native
Electron or full authenticated workbench verification.

Latest character-picker refinement: the portrait is a 52-px button at the left,
beside the vertical camera icons. Clicking opens a glass menu of the existing
workbench characters; title, portrait, records and history follow the selection.
The current chat role stays unchanged. Other roles' existing local archives are
read-only, with certainty/source labels and an explicit empty state when absent.
The main native-memory editor remains available for Bigfish. Switching clears
old contents before fetching; owner/generation guards discard stale responses.

Browser checks passed menu rendering, loaded 52 × 52 portrait, Bigfish → Claude
(6 independent synthetic records), read-only popup/no model settings, Claude →
Yui (0 records/empty state), and Yui → Bigfish (220 records). Error/warning log
was empty. Three new storage-viewer tests and 20 existing focused chat/replication
tests passed. Real other-role native-memory engines are not integrated by this
view-only change. The menu's Yui/Claude artwork is reused from the existing bundle.

Character-label refinement: the central 大肥鱼 canvas text is removed. A 30 × 30
avatar from the existing bundled `assets/icons/bigfish.webp` appears at the map's
top center, preserving the minimal controls and upper-right legend. Browser
verification confirmed the loaded image dimensions, absence of the central
caption in the rendered map, and an empty error/warning log. The existing source
safety check now scopes untrusted images to memory cards, allowing this trusted
character asset.

Latest refinement, 2026-11-04: camera controls now use only three vertically
stacked 16-px Lucide plus, minus and circular double-arrow icons. Buttons have
transparent backgrounds and no visible text, while retaining accessible names
and hover titles. Auto-rotation was removed. Lower map instructions, the dated
output and the all-time button were removed; the only timeline copy is 时间
above its left edge. The rail is 1 px and the luminous draggable thumb is 6 px.
Upper-right count/legend styling is preserved. Browser screenshot and computed
styles confirmed the icon order, empty text and rgba(0,0,0,0) button backgrounds.
Zoom/reset remained functional; timeline Home filtered to 4 synthetic records,
and End restored 220. The browser warning/error log was empty. No additional
storage tests were needed for this presentation/control-only follow-up.

Follow-up, 2026-11-04: the user requested floating details and a translucent
glass treatment. The fixed inspector column and duplicate canvas tooltip are
removed. Details now form a non-modal floating editor beside the selected star,
clamped inside the map with close/Escape handling. Selection and editor focus
pause automatic rotation. The surface uses rgba(18,32,51,0.58), a 20-px backdrop
blur, restrained pale borders and translucent input/button fills. The inner card
is transparent. Browser verification passed close/reopen, priority save (96),
cross-view draft retention, 440-px layout and desktop positioning. At 1170 × 800,
the 350-px floating editor stayed fully inside the map. Resizing the textarea
also triggers placement recalculation. The viewport override was reset.

Scope: the existing Nekofans main-agent memory panel. This is a production-source
change with an isolated browser fixture, not a replacement website. The installed
application and prior installers have not been rebuilt or replaced.

## Reference and observed implementation

The user's reference images 1–3 establish the dark spatial star field, luminous
typed nodes, ownership rays, selected-memory details, camera controls and time
slider. Image 4 establishes readable memory cards with editable importance,
pinning and forgetting. All four reference images were visible in the task;
rendered desktop and narrow-window captures were inspected in the in-app browser
alongside those references. Focused inspection covered the selected-memory editor
and the priority, pin and delete controls in the list.

The app's existing pale settings shell is intentionally retained. No external
navigation, invented semantic edges, simulated retention percentages or decay
curves are introduced. The star field is a canvas rendering of actual records,
not an illustration or a substituted image asset. Ownership rays are labeled.

## Findings and fixes

- P2, desktop layout: the settings block initially displaced the map and timeline
  below the viewport. Moved settings below the explorer and bounded the map height
  against the available viewport. The revised capture shows the camera, graph,
  time slider and detail editor together at the default 1280 × 720 viewport.
- P2, deleted-record search: an active text filter initially prevented locating
  the matching deleted record. The ledger now exposes its previous value for
  inspection/search only; the record still has no active value and cannot enter
  recall. Repeated the search → delete → deleted filter → explicit restore flow.
- P2, list density: moved type/source and priority controls into a shared desktop
  card header. Narrow layouts stack those controls without clipping.

No remaining P0/P1/P2 visual or interaction findings in the verified browser
states. Native Electron acceptance is separately blocked as described below.

## Fidelity surfaces

- Typography: existing system-font stack; clear title/body/source hierarchy;
  long content wraps in editable textareas and source labels. Small graph labels
  are supplementary to the complete text editor and text-list alternative.
- Layout: full-width graph + floating detail editor; readable list with 30-record pagination;
  bounded floating editor at narrow sizes. At 440 × 800, document scroll width equaled
  440 px. The graph, filters and list controls remained within the viewport.
- Color: near-black graph, gold facts, rose preferences, cyan episodes and violet
  summaries/reflections; pale green list badges and priority controls. Confirmation,
  deletion and conflict state are described in text, not color alone.
- Visual quality: stable record-specific spatial positions, luminous nodes and
  center; size depends on priority/pin. Up to 800 nodes per frame; the full set
  remains searchable and available through the list. No synthetic semantic edges.
- Copy/content: real kinds, certainty, sources and dates; explicit priority range,
  saved/error states, empty states and deletion/restore text. Preview memories
  are synthetic and labeled in their content and browser title.

## Verified interactions

In-app browser: switch both directions, save priority (85 → 97), observe list
reordering, retain edited text across view switches, save a correction, render
HTML-looking source text without creating an image element, search, delete,
locate deleted content, explicitly restore, paginate (2/8), arrow-key selection,
rotation toggle, time-slider Home (4 records) and reset, empty search results,
and 440-px responsive views. Browser error/warning log was empty. Viewport override
was reset; the preview tab remains open for review.

Storage/API checks: 27 Node tests passed without skips, and one real native
FactStore recovery test passed with additional priority ordering, metadata-only
fact/episode identity reuse and invalid-value assertions. All data is synthetic;
no real supplier account or model connectivity is claimed.

The existing Electron memory UI test failed before renderer startup: Windows
denied the sandbox access to the test Electron installation. Automatic approval
review rejected broadening that directory's AppContainer read ACL. No sandbox
bypass was applied. Browser visual acceptance and storage verification above are
the completed alternatives; native Electron UI acceptance remains unverified.

## Follow-up

- P3: a large memory collection may benefit from additional clustering controls.
  Current ownership layout avoids presenting invented relationships as facts.
- Run native Electron UI acceptance in a normally installed test runtime before
  a packaged release. No installer was requested or produced by this change.
