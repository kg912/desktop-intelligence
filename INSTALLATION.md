# Installation Guide

This guide walks you through setting up **Desktop Intelligence** from scratch on an Apple Silicon Mac.

---

## Prerequisites

### Hardware
| RAM | Status |
|-----|--------|
| **64 GB+** | ✅ Ideal — runs large MoE models (35B+) with full performance and headroom |
| **48 GB** | ✅ Recommended minimum for large models |
| **32 GB** | ⚠️ Workable with smaller models (7B–14B); avoid loading 35B+ models |
| **< 32 GB** | ❌ Not recommended — insufficient for most capable models |

**Apple Silicon (M1 / M2 / M3 / M4 / M5) only.** Intel Macs are not supported.

### Software
- **macOS 13 Ventura** or later
- **Python 3** (for chart rendering) — check with `python3 --version`. Install via [python.org](https://www.python.org/downloads/macos/) or Homebrew if missing
- **matplotlib + numpy + scipy** Python packages (for visualizations):
  ```bash
  pip3 install matplotlib numpy scipy
  ```

---

## Step 1 — Install LM Studio

1. Go to **[lmstudio.ai](https://lmstudio.ai/)** and download the macOS installer
2. Open the downloaded `.dmg` and drag LM Studio to your Applications folder
3. Launch LM Studio at least once to complete initial setup

### Install the `lms` CLI

Desktop Intelligence uses the `lms` command-line tool to manage the LM Studio server and model loading. Install it from inside LM Studio:

1. Open LM Studio
2. Open the **Settings** (gear icon, bottom-left)
3. Go to **"Local Server"** or **"CLI"** tab
4. Click **"Install lms CLI"**

Verify it works:
```bash
lms --version
```

If `lms` is not found, add `~/.lmstudio/bin` to your shell PATH:
```bash
# Add to ~/.zshrc or ~/.bash_profile
export PATH="$HOME/.lmstudio/bin:$PATH"
```

---

## Step 2 — Download a Model

Desktop Intelligence works with **any model you have downloaded in LM Studio**. You'll choose which model to use on first launch.

**Top recommendation (works on 48 GB+ machines):**
- `google/gemma-4-26b-a4b` — Gemma 4's 26B Mixture-of-Experts model with only 4B parameters active at once. Exceptional reasoning, built-in vision support, and fast inference. Download directly in LM Studio (available as GGUF — no conversion needed).

**Also excellent (48 GB+ recommended):**
- `mlx-community/Qwen3.5-35B-A3B-6bit` — 35B MoE model optimised for Apple Silicon via MLX. Outstanding thinking mode. ~71 tok/s on M5 Pro (~22 GB download).

**Good options for 32 GB Macs:**
- Any Qwen3 14B MLX model from the `mlx-community` namespace
- Any DeepSeek-R1 distilled 7B–14B MLX model

### Option A — Download via LM Studio UI (Recommended)

1. Open LM Studio
2. Click the **Search** tab (magnifying glass icon, left sidebar)
3. Search for your chosen model
4. Click **Download** and wait for it to complete

### Option B — Download via CLI

```bash
# Example — replace with any model ID from LM Studio's catalogue
lms get mlx-community/Qwen3.5-35B-A3B-6bit
```

---

## Step 3 — Configure LM Studio

### Enable the Local Server

1. In LM Studio, click the **Local Server** tab (left sidebar — looks like `<->`)
2. Click **"Start Server"** if it isn't already running
3. The server runs on `http://localhost:1234` by default — leave this as-is

### (Optional) Pre-load a Model

Desktop Intelligence auto-loads your chosen model on launch. However, you can pre-load it manually to confirm everything works:

1. In LM Studio, go to the **Local Server** tab
2. Under **"Load a model to use it"**, select your downloaded model
3. Wait for the model to load (~30–60 seconds on first load)

---

## Step 4 — Install Desktop Intelligence

### Option A — Use the Pre-built DMG (Recommended)

1. Download `Desktop Intelligence-1.6.0-arm64.dmg` from the releases
2. Open the `.dmg` file
3. Drag **Desktop Intelligence** to your Applications folder
4. Launch the app

> **"App can't be opened" warning?** Right-click the app → **Open** → **Open** again. This bypasses Gatekeeper for unsigned apps.

### Option B — Build from Source

Requires **Node.js 20+** ([nodejs.org](https://nodejs.org/)):

```bash
# Clone the repository
git clone <repo-url>
cd desktop-intelligence

# Install dependencies
npm install

# Run in development mode
npm run dev

# OR build a production DMG
npm run package
```

---

## Step 5 — First Launch

1. Open **Desktop Intelligence**
2. **On first launch**, a welcome screen appears:

   ![First-launch model selector](app_images/setup_screen_model_selector_form.png)

   - **Active Model** dropdown — lists every model you have downloaded in LM Studio. Select the one you want to use.
   - **Context Length** slider — controls how much conversation history the model can see. Default is 32K tokens, which is comfortable for most use. See Step 6 for guidance on higher values.
   - Click **Save & Connect**

   > ⚠️ **RAM warning:** Large models (35B+) at high context lengths consume significant unified memory. A 35B model at 128K context can use 40–55 GB of RAM. On 32 GB machines, use a 7B–14B model and keep context at 32K or below.

3. The app will start the LM Studio server and load your chosen model — this takes **30–60 seconds**
4. On subsequent launches, your saved model and context length are applied automatically — you go straight to the connection overlay, then into the app
5. Once the overlay clears, you're ready to chat

---

## Step 6 — Set Your Context Length (Optional)

The model's context window controls how much conversation history it can see. The default is 32K tokens, which is comfortable for most conversations. For long document analysis or extended conversations, you may want more.

1. Click the **⚙️** (cog icon) in the bottom-left of the sidebar to open Settings
2. In the **Model** tab, adjust the **Context Length** slider — recommended values:
   - **32K** (32 768) — default, good for general use
   - **64K** (65 536) — good for document Q&A and long conversations
   - **128K** (131 072) — maximum; uses significantly more RAM

   > ⚠️ **RAM warning:** Higher context lengths consume more unified memory. On 64 GB machines, 128K is fine. On 32 GB machines, stay at 32K or below — going higher with a large model risks system memory pressure and slowdowns.

3. Click **Reload Model** and wait ~30–60 seconds
4. Your preference is saved and applied automatically on every future launch

---

## Step 7 — Enable Web Search (Optional)

Real-time web search is powered by the **Brave Search API** (free tier: 2 000 queries/month).

1. Sign up at [brave.com/search/api](https://brave.com/search/api/) and copy your API key
2. Click **⚙️** in the sidebar → **Web Search** tab
3. Toggle **Enable Brave Search** on
4. Paste your API key and click **Save**

   ![Brave Search MCP settings](app_images/settings_screen_brave_search_mcp_api_key_and_toggle.png)

Once enabled, the app will automatically perform a search before answering time-sensitive questions (current prices, recent news, live data). For knowledge questions and coding help, search is skipped.

---

## Troubleshooting

### App shows "Connecting…" and never loads

- Make sure LM Studio is installed and the `lms` CLI is available (`lms --version`)
- Check that the local server is enabled in LM Studio (port 1234)
- Open Terminal and run the app directly to see logs:
  ```bash
  /Applications/"Desktop Intelligence.app"/Contents/MacOS/"Desktop Intelligence"
  ```

### Model loads but generates very slowly

- Ensure no other GPU-intensive apps are running
- Check Activity Monitor → GPU History — the model should be using the GPU
- For best performance on Apple Silicon, use the **MLX** version of your chosen model (look for models in the `mlx-community` namespace on Hugging Face / LM Studio), not GGUF or other formats

### Charts don't render

- Verify Python 3 is installed: `python3 --version`
- Install required packages: `pip3 install matplotlib numpy scipy`
- Charts require `python3` to be on your system PATH

### "Context window exceeded" error in chat

- Open settings (⚙️) and reduce the context length, or start a new chat
- Long conversations accumulate history — the sliding window trims the oldest messages but very long thinking-mode sessions can still overflow

### PDF attachment doesn't seem to work

- Make sure you attach the PDF **before** sending your first message in a new chat
- The app extracts text from PDFs — scanned/image-only PDFs with no embedded text will not work

---

## Updating

To update to a new version, simply replace the app in your Applications folder with the new DMG. Your chat history and settings are stored separately in `~/Library/Application Support/Desktop Intelligence/` and will not be affected.

---

*Last updated: 2026-04-05 — v1.6.0*
