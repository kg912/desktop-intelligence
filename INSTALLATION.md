# Installation Guide

This guide walks you through setting up **Desktop Intelligence** from scratch on an Apple Silicon Mac.

Desktop Intelligence supports two AI backends. **Choose one:**

| Backend | Best for | Setup effort |
|---------|----------|--------------|
| **LM Studio** | MLX models, maximum performance on Apple Silicon | Moderate — requires `lms` CLI |
| **Ollama** | Simplicity, broad model library | Easy — install and run |

You can switch backends at any time from Settings — you don't need to commit at install time.

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

## Step 1 — Install Your AI Backend

### Option A — LM Studio (Recommended for MLX models)

1. Go to **[lmstudio.ai](https://lmstudio.ai/)** and download the macOS installer
2. Open the downloaded `.dmg` and drag LM Studio to your Applications folder
3. Launch LM Studio at least once to complete initial setup

**Install the `lms` CLI** — Desktop Intelligence uses this to manage the server and model loading:

1. Open LM Studio
2. Open **Settings** (gear icon, bottom-left)
3. Go to the **"Local Server"** or **"CLI"** tab
4. Click **"Install lms CLI"**

Verify it works:
```bash
lms --version
```

If `lms` is not found, add it to your shell PATH:
```bash
# Add to ~/.zshrc or ~/.bash_profile
export PATH="$HOME/.lmstudio/bin:$PATH"
```

### Option B — Ollama

1. Go to **[ollama.com](https://ollama.com/)** and download the macOS app
2. Open the downloaded `.dmg` and drag Ollama to your Applications folder
3. Launch Ollama — it runs as a menu bar app and starts a local server on `http://localhost:11434`

Verify it works:
```bash
ollama --version
```

That's it — no CLI configuration required.

---

## Step 2 — Download a Model

You'll choose which model to use on first launch. Download it in your chosen backend before opening Desktop Intelligence.

### Recommended Models

**Top pick (48 GB+ machines):**
- `google/gemma-4-26b-a4b` — Gemma 4's 26B MoE with only 4B parameters active. Exceptional reasoning, vision support, fast inference. Available in LM Studio (GGUF) or Ollama.

**Also excellent (48 GB+ recommended):**
- `mlx-community/Qwen3.5-35B-A3B-6bit` — 35B MoE optimised for Apple Silicon via MLX. Outstanding thinking mode. ~71 tok/s on M5 Pro. LM Studio only.

**Good options for 32 GB Macs:**
- Any Qwen3 14B MLX model — LM Studio
- Any DeepSeek-R1 distilled 7B–14B — LM Studio or Ollama
- `llama3.2:latest` — quick Ollama download, good all-rounder

### If you chose LM Studio

**Option A — via UI (Recommended)**

1. Open LM Studio
2. Click the **Search** tab (magnifying glass icon, left sidebar)
3. Search for your chosen model and click **Download**

**Option B — via CLI**

```bash
lms get mlx-community/Qwen3.5-35B-A3B-6bit
```

### If you chose Ollama

```bash
# Pull any model from the Ollama library
ollama pull gemma3:27b
# or
ollama pull llama3.2
```

Browse available models at [ollama.com/library](https://ollama.com/library).

---

## Step 3 — Verify Your Backend

### If you chose LM Studio

Desktop Intelligence manages the LM Studio server automatically — you don't need to start it manually. To confirm your setup is correct:

1. Open LM Studio and go to the **Local Server** tab (looks like `<->`)
2. Verify the server port is `1234` (the default — leave it as-is)
3. You can optionally pre-load your model here to confirm it downloads correctly

### If you chose Ollama

Ollama starts automatically as a menu bar app. Verify it's running:

```bash
curl http://localhost:11434/api/tags
```

You should see a JSON list of your downloaded models. Desktop Intelligence manages Ollama from this point on.

---

## Step 4 — Install Desktop Intelligence

### Option A — Use the Pre-built DMG (Recommended)

1. Download the latest `Desktop Intelligence-*-arm64.dmg` from the [Releases](../../releases/latest) page
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

   - **AI Provider** — select **LM Studio** or **Ollama** (whichever you installed in Step 1)
   - **Active Model** dropdown — lists every model you have downloaded in your chosen backend. Select the one you want to use.
   - **Context Length** slider — controls how much conversation history the model can see. Default is 32K tokens, which is comfortable for most use. See Step 6 for guidance on higher values.
   - Click **Save & Connect**

   > ⚠️ **RAM warning:** Large models (35B+) at high context lengths consume significant unified memory. A 35B model at 128K context can use 40–55 GB of RAM. On 32 GB machines, use a 7B–14B model and keep context at 32K or below.

3. The app will start the backend server and load your chosen model — this takes **30–60 seconds** on first load
4. On subsequent launches, your saved provider, model, and context length are applied automatically — you go straight to the connection overlay, then into the app
5. Once the overlay clears, you're ready to chat

---

## Step 6 — Customise Settings (Optional)

Click **⚙️** in the bottom-left of the sidebar to open the full-screen Settings panel.

![Model settings](app_images/settings_screen_model_selection_and_context_length.png)

### Context Length

Controls how much conversation history the model can see. The default is 32K tokens, comfortable for most use.

| Value | Use case |
|-------|----------|
| **32K** | General chat, coding help |
| **64K** | Long conversations, document Q&A |
| **128K** | Maximum; use only on 48 GB+ with models that support it |

> ⚠️ **RAM warning:** Higher context uses more unified memory. On 32 GB Macs, stay at 32K or below with large models.

### Generation Parameters

Fine-tune how the model generates text:

| Parameter | Default | What it does |
|-----------|---------|--------------|
| **Temperature** | 0.7 | Higher = more creative, lower = more deterministic |
| **Top P** | 0.95 | Nucleus sampling — lower focuses on most likely tokens |
| **Max Output Tokens** | 16 384 | Cap on response length per message |
| **Repeat Penalty** | 1.1 | Penalises repetitive output |

### System Prompt

Enter a custom system prompt to give the model persistent instructions — a persona, formatting rules, or domain focus. Applies to all new conversations. Leave blank to use the app's built-in base prompt.

### Applying Changes

Click **Reload Model** after making any changes. This takes 30–60 seconds. All settings are saved automatically and applied on every future launch.

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

**If using LM Studio:**
- Confirm `lms` CLI is available: `lms --version`
- Check the LM Studio local server is on port 1234 (default)

**If using Ollama:**
- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- If it's not running, open the Ollama app from your Applications folder

**Either backend:**
- Open Terminal and run the app directly to see diagnostic logs:
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

*Last updated: 2026-04-07 — v1.7.4*
