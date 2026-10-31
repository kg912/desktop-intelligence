# M1 Pro UI jank — round 3 (measurements)

Date: 2026-10-31 · Source 3.2.71 · Electron 44.5.1 (Chromium 152.0.7977.130)

**Read this first: every number below was measured on the M5 Pro** (`Mac17,9`, macOS 27.0.1 26A434).
There is no M1 Pro in this environment. The M1-only parts of E1/E2/E3 are listed in §5 with the exact commands to run.

The earlier captures (`perf-e33-*`, `perf-e44-*`, `perf-b90-*`, `perf-b93-*`) were **also M5 Pro**
(progress.md rows 360, 363). They show what Electron 44 costs on the machine that feels fine. They are not M1 data.

Harness: `scripts/perf-scroll-capture.mjs` (the 103-chart chat "what is -log(p)", 120 synthetic wheel events, same window:
scroll container 634 px tall at (794,369) in every run). Metrics come from `scripts/perf-scroll-metrics.mjs` (new; the earlier
round's metric script was never committed, so all old traces were recomputed with this one):

- **busy**: union of top-level tasks on the renderer main thread, in ms per burst
- **wheel p95**: `EventLatency` MOUSE_WHEEL begin→end p95
- **1st-upd p95**: FIRST_GESTURE_SCROLL_UPDATE p95
- **dropped / smooth**: `PipelineReporter` STATE_DROPPED / of which affects_smoothness
- **>8.3**: top-level main-thread tasks longer than one 120 Hz frame

Every capture (old and new) ran on the built-in panel at 120 Hz: the BeginFrame interval is 8333 µs in all 13 traces checked (E33 ×3, E44 ×3, b93-a, all new runs except E5).

## 1. Experiments

Cells show median (min–max) over N = 3 runs. All rows ran on the M5 Pro.

| # | Condition | Build | busy ms | wheel p95 ms | 1st-upd p95 ms | dropped (smooth) | >8.3 ms tasks | max task ms | Viz thread ms |
|---|---|---|---|---|---|---|---|---|---|
| R | Electron 33 (old capture, recomputed) | beta-83 pkg | 500 (499–515) | 21.1 (20.9–22.8) | 37.7 (37.6–37.9) | 7 (0) | 14 | 35.4 | 23 |
| R | Electron 44 (old capture, recomputed) | beta-85 pkg | 665 (649–675) | 29.9 (29.4–30.0) | 86.6 (84.4–120.9) | 12 (6) | 19 | 34.7 | 25 |
| R | E44 beta-93 (old capture, recomputed) | beta-93 pkg | 662 (653–665) | 28.7 (28.6–29.0) | 84.5 (84.1–87.9) | 10 (1) | 20 | 31.3 | 25 |
| R | `content-visibility:auto` off / on (old captures) | beta-90 pkg | 676 → 1197 (1175–1250) | 28.6 → 31.9 | 82.2 → 54.0 | 12 → 12 | 20 → 37 | 31.7 → 30.6 | 28 → 31 |
| E1 | Graphite **on** (default) | 3.2.71 pkg | 719 (705–721) | 30.3 (30.2–30.7) | 94.0 (85.8–94.1) | 13 (2) | 23 | 32.5 | 27 |
| E1 | `DI_GRAPHITE=0` → **software compositing** (see E1 note) | 3.2.71 pkg | 727 (725–739) | 30.4 (29.9–30.4) | 94.2 (93.9–95.1) | 13 (2) | 25 | 32.4 | **999** (960–1029) |
| E5 | Renderer CPU throttled 2× (`CPU_THROTTLE=2`), a rough M1-class proxy | 3.2.71 pkg | **1398** (1370–1420) | **40.0** (38.2–41.2) | 84.1 (81.7–95.2) | **38** (7) | **53** | **61.3** | 27 |
| E2 | App's own `chrome://gpu` (Graphite on, and with each Graphite-off switch) + Chrome 156 dump | 3.2.71 pkg | — | — | — | — | — | — | — |
| E3 | `--enable-logging=stderr --v=1` across startup + scroll burst | 3.2.71 pkg | 0 `ProduceOverlay` / `Invalid mailbox` lines; 0 ERROR/WARNING lines from the GPU process | | | | | | |
| E4 | Inspect shipped `app.asar` + a sourcemap build | 3.2.71 pkg | see §2 | | | | | | |

The table has more conditions than E1–E4 because E5 was added; E1's own note is just below.

**E1 note.** In Electron 44 on Apple Silicon there is no Ganesh fallback. `--disable-skia-graphite` and
`--disable-features=SkiaGraphite` both leave the GPU process with `gl=disabled, angle=none` and `skiaBackendType: None`.
They also put `--disable-gpu-compositing` on the renderer, and `getContext('webgl')` returns null.
So E1's off row compares GPU compositing with **software** compositing; it is not Graphite vs Ganesh.

**Where the main-thread time goes** (self time inside tasks longer than 8.3 ms):

| Item | E33 | E44 (3.2.71) | E44 at 2× |
|---|---|---|---|
| Number of such tasks | 26 | 38 | 106 |
| App JS | 188 ms | 167 ms | 477 ms |
| `ScrollLayer` | 3 ms | 49 ms | 275 ms |
| `performPostLayoutTasks` | 3 ms | 49 ms | 271 ms |

- The CPU profile's `(program)` (Blink native code) goes 243 → 430 ms from E33 to E44.
- The largest app function is `updateScrollShadows`: 67 ms (E33), 80 ms (3.2.71), 161 ms (2×).
  It is called from a React commit effect, not from the scroll handler.

## 2. Verdicts

- **Graphite drives the M1 jank: Inconclusive (cannot be tested as specified).**
  No Ganesh path exists in Electron 44 on macOS. With the GPU fully off, renderer busy goes 719 → 727 ms and wheel p95 30.3 → 30.4.
  **Do not ship the flag**: it disables GPU compositing and WebGL.
- **Electron 44 regressed scroll vs 33: Confirmed (M5).** Busy 500 → 665 ms (+165 per burst), 1st-upd p95 37.7 → 86.6, >8.3 ms tasks 14 → 19.
- **"The E44 regression alone uses up the 8.3 ms budget at 120 Hz": Refuted as stated.**
  +165 ms over ~285 vsyncs is about +0.6 ms per frame; max task is unchanged (35.4 vs 34.7 ms).
  The M5 shows the same regression at the same 120 Hz and feels fine.
- **Earlier wheel→present p95 "37–40 vs 31–32": Corrected.** EventLatency MOUSE_WHEEL p95 is 29.9 (E44) vs 21.1 (E33).
  The earlier metric's definition was never committed; the direction and the ~+9 ms gap hold.
- **`content-visibility: auto` regression: Confirmed.** Busy 676 → 1197 ms (+77%), >8.3 ms tasks 20 → 37.
- **Keystroke re-render hypothesis refuted: Not re-checkable.** Row 357 recorded render counts but saved no capture file; left as refuted.
- **Renderer main thread is CPU-bound and falls apart on a ~2× slower CPU: Confirmed as a proxy (not M1 data).**
  - Busy 719 → 1398 ms, tasks >16 ms 5 → 25, dropped frames 13 → 38, wheel p95 30.3 → 40.0.
  - GPU-side work is unchanged under the throttle (Viz 27 → 27 ms, GPU main 162 → 158 ms).
- **Pessimistic Metal feature block is M1-specific: Refuted.** `hasCheapRenderPass` Disabled, `alwaysPreferStagedTextureUploads` Enabled,
  `allowInlineConstVertexData` and `hasExplicitMemBarrier` Disabled appear the same on the M5, in both Chrome 156 and the app (§3).
- **DRDC Disabled / Raw Draw Disabled are anomalies: Refuted.** All three dumps show the same values; this is the macOS default.
- **120 Hz explains "M1 only": Refuted.** Both machines' internal panels report 120.0006 Hz, 30 bpp, BGRA_8888, and every M5 capture ran at 8333 µs.
- **Overlay / mailbox failure: Inconclusive on M1; not seen on M5.**
  - M5 app: 0 occurrences with `--v=1` across startup and the scroll burst. GPU-process logging does reach stderr (`viz_main_impl.cc` lines are present).
  - The M1 lines are from 15 Oct (`1015/120332`), from Chrome 154, one occurrence each.
- **React production build: Confirmed.** The shipped entry chunk contains "Minified React error" and none of React's dev warnings.
- **mermaid + echarts in the entry chunk: Confirmed, with corrected sizes.** Attribution comes from a sourcemap build of the same source:

  | Contents of `index-CnM5BRt2.js` | Size |
  |---|---|
  | echarts | 2.22 MB |
  | zrender | 0.51 MB |
  | mermaid core | 0.71 MB |
  | katex | 0.48 MB |
  | framer-motion | 0.25 MB |
  | react-dom | 0.21 MB |

  - Mermaid's diagram renderers are already in ~110 lazy chunks. The "3.16 MB" figure is `mermaid.min.js` in node_modules, not what ships.
- **5.9 MB single entry chunk, no vendor split: Confirmed, corrected to 6,294,831 B** (6.29 MB / 6.0 MiB). One `<script>` tag; 10.65 MB of renderer JS in total.
  No effect on scroll was measured; it only affects startup parse time.

## 3. GPU dump diff (E2)

**Inputs:**
- `docs/perf/gpu/m1pro-chrome154.txt`: the existing M1 Pro export from Chrome 154. There is no app dump from the M1.
- `docs/perf/gpu/m5pro-chrome156.txt`: Chrome 156 on the M5, throwaway profile.
- `docs/perf/gpu/m5pro-app-electron44.txt`: the app's own GPU process, taken by `Page.navigate` to `chrome://gpu` over CDP.

`scripts/perf-gpu-diff.py`: 362 fields identical across all three, 65 differ.
The 65 consist of:
- version strings
- the M5's two external monitors (100 Hz and 60 Hz, absent on the M1)
- Dawn toggles that appear only on M5 (`metal_serialize_timestamp_generation`, `metal_polyfill_unpack_2x16_*`: workarounds for newer GPUs)
- the rows below

| Section | Field | M1 Pro · Chrome 154 | M5 Pro · Chrome 156 | M5 Pro · app (E44) | Same? |
|---|---|---|---|---|---|
| Graphics Feature Status | Canvas / Compositing / Rasterization / WebGL / WebGPU / Video Decode | Hardware accelerated | Hardware accelerated | Hardware accelerated | yes |
| Graphics Feature Status | Direct Rendering Display Compositor | Disabled | Disabled | Disabled | yes |
| Graphics Feature Status | Raw Draw | Disabled | Disabled | Disabled | yes |
| Graphics Feature Status | Skia Graphite | Enabled | Enabled | Enabled | yes |
| Graphics Feature Status | Multiple Raster Threads / OpenGL | Enabled | Enabled | Enabled | yes |
| Graphics Feature Status | TreesInViz | Disabled | Disabled | Disabled | yes |
| Version Information | Chrome version | 154.0.8037.99 | 156.0.8078.74 | 152.0.7977.130 | no |
| Version Information | ANGLE commit | e12217f3e133 | 127e783de334 | e71c7344f185 | no |
| Driver Information | Skia Backend | GraphiteDawnMetal | GraphiteDawnMetal | GraphiteDawnMetal | yes |
| Driver Information | GL implementation parts | (gl=egl-angle,angle=metal) | same | same | yes |
| Driver Information | Display type | ANGLE_METAL | ANGLE_METAL | ANGLE_METAL | yes |
| Driver Information | **Max. MSAA samples** | **4** | **8** | **8** | **no** |
| Driver Information | Machine model | MacBookPro 18.3 | Mac 17.9 | Mac 17.9 | no |
| Driver Information | GPU process crash count | 0 | 0 | 0 | yes |
| Driver Information | Disabled Extensions | GL_KHR_blend_equation_advanced(_coherent) | same | same | yes |
| Driver Bug Workarounds | disable_2d_canvas_auto_flush, enable_webgl_timer_query_extensions, disabled_extension_GL_KHR_blend_equation_advanced(_coherent) | present | present | present | yes |
| ANGLE Features | hasCheapRenderPass (Metal) | Disabled | Disabled | Disabled | yes |
| ANGLE Features | allowInlineConstVertexData (Metal) | Disabled | Disabled | Disabled | yes |
| ANGLE Features | alwaysPreferStagedTextureUploads (Metal) | Enabled | Enabled | Enabled | yes |
| ANGLE Features | hasExplicitMemBarrier (Metal) | Disabled | Disabled | Disabled | yes |
| ANGLE Features | emulatePixelLocalStorage (Frontend) | Enabled | Enabled | Enabled | yes |
| ANGLE Features | limitMaxVisibilityQueryOffset (Metal) | Enabled | Enabled | — (absent in ANGLE e71c73) | no (version) |
| ANGLE Features | loseHardenedContextOnBackendError (Frontend) | Enabled | Enabled | — (absent) | no (version) |
| Compositor Information | Tile Update Mode / Partial Raster | Zero-copy / Enabled | same | same | yes |
| Display(s) Information | internal panel: refresh / bpp / buffer / HDR max | 120.0006 / 30 / BGRA_8888 / 1.2 | same | same | yes |
| Display(s) Information | external monitors | none | 1920×1080 @100 Hz, 1920×1080 @60 Hz | same | no |
| Log Messages | `shared_image_manager.cc:376 ProduceOverlay … non-existent mailbox` | 1 (15 Oct) | 0 | 0 | no |
| Log Messages | `skia_output_device_buffer_queue.cc:258 Invalid mailbox` | 1 (15 Oct) | 0 | 0 | no |

Three surprises:
1. **The whole Metal feature block is identical on M5.** The round-2 render-pass and staging-copy argument therefore cannot explain an M1-only symptom.
2. **Max MSAA samples are 4 on M1 vs 8 on M5.** This is the only GPU-capability field that differs between the machines.
   The compositor doesn't use MSAA for tiles, so it is unlikely to matter.
3. **The M5 has two external monitors at 100 Hz and 60 Hz.** If "the M5 feels fine" was judged on one of them, the 8.3 ms vs 10–16.7 ms budget is a confound.

## 4. Recommended next change

**Run the scroll capture on the M1 Pro (§5, about 10 min) before changing any product code.**
The decisive question is whether M1 busy time scales like the 2× proxy (~1.4 s, 25 tasks >16 ms). No experiment here can answer it.

If it does, the first code change is: **in `ThinkingAccordion` (`src/renderer/src/components/chat/MessageBubble.tsx:206`), skip the
`updateScrollShadows` mount effect while the panel is collapsed (`!open && !isStreaming`).**
- The effect reads `scrollHeight` (a forced layout) every time a virtualized row mounts, even when the panel is 0 px tall.
- Measured cost: 80 ms per burst on M5 and 161 ms at 2×. It is the largest single app-side item on the main thread.
- Judge it with the same harness: target busy and >8.3 ms task counts, N = 3.
- The rest of the Electron 44 delta (`ScrollLayer` and `performPostLayoutTasks`, +~90 ms on M5) is inside Chromium, and the app can't remove it.

## 5. Not tested, and why

- **E1 on M1, E2 app dump on M1, E3 fresh logs on M1:** there is no M1 Pro here. On the M1, with the 3.2.71 dmg installed, run from the repo:
  ```bash
  APP="/Applications/Desktop Intelligence.app/Contents/MacOS/Desktop Intelligence"
  # E3 + capture: start the app with logging, wait ~10 s, then run 3 captures
  # (on the M1, CHAT_TITLE_SNIPPET must name a heavy chart chat that exists in that DB)
  "$APP" --remote-debugging-port=9222 --enable-logging=stderr --v=1 2> m1-e3.log &
  for r in a b c; do CHAT_TITLE_SNIPPET='…' OUT_NAME=perf-r3-m1-$r node scripts/perf-scroll-capture.mjs; done
  grep -c -E "ProduceOverlay|Invalid mailbox" m1-e3.log
  node scripts/perf-gpu-dump.mjs docs/perf/gpu/m1pro-app-electron44.txt   # navigates the page away; quit the app afterwards
  node scripts/perf-scroll-metrics.mjs scripts/perf-r3-m1-{a,b,c}.json
  python3 scripts/perf-gpu-diff.py M1=docs/perf/gpu/m1pro-app-electron44.txt M5=docs/perf/gpu/m5pro-app-electron44.txt
  ```
  For a like-for-like comparison, run the same three captures on the M5 against that same chat.
- **Graphite vs Ganesh:** this can't be done in Electron 44 on macOS, because both switches give software compositing (E1 note).
- **The 2× throttle is only a proxy.** It slows the renderer main thread only. It doesn't model the M1's GPU, memory bandwidth, or E/P-core scheduling.
- **The M1 GPU dump is Chrome 154; the M5 dumps are Chrome 156 and Electron 44 (Chromium 152).** Version-dependent ANGLE/Dawn rows are marked.
- **Which display "M5 feels fine" was judged on** is unknown (see surprise 3).
- **`backdrop-filter` is unmeasured** (left in place as instructed). The scroll repro doesn't mount any of the three remaining scrims.
- **The keystroke path was not re-measured** (no artifact to recompute; see verdicts).
- **The Electron 33 capture can't be re-run.** The installed app is now 3.2.71/E44, so the E33 numbers are recomputed from the 4 Oct traces only.
- **`dist/` was rebuilt to 3.2.71 with `npm run package` (not edited by hand).** The 3.2.36 dmg is still in `dist/`.
