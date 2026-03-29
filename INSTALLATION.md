# Installation Guide

This guide walks you through setting up **Desktop Intelligence** from scratch on an Apple Silicon Mac.

---

## Prerequisites

### Hardware
| RAM | Status |
|-----|--------|
| **64 GB+** | ✅ Ideal |
| **48 GB** | ✅ Recommended minimum |
| **< 48 GB** | ❌ Not recommended — the model requires ~29 GB free memory |

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

## Step 2 — Download the Model

Desktop Intelligence is built around **`mlx-community/Qwen3.5-35B-A3B-6bit`** — a 35-billion-parameter Mixture-of-Experts model quantized to 6-bit for Apple Silicon via the MLX framework.

### Option A — Download via LM Studio UI (Recommended)

1. Open LM Studio
2. Click the **Search** tab (magnifying glass icon, left sidebar)
3. Search for: `Qwen3.5-35B-A3B-6bit`
4. Find the entry from **`mlx-community`** and click **Download**
5. Wait for the download to complete (~22 GB)

### Option B — Download via CLI

```bash
lms get mlx-community/Qwen3.5-35B-A3B-6bit
```

---

## Step 3 — Configure LM Studio

### Enable the Local Server

1. In LM Studio, click the **Local Server** tab (left sidebar — looks like `<->`)
2. Click **"Start Server"** if it isn't already running
3. The server runs on `http://localhost:1234` by default — leave this as-is

### (Optional) Pre-load the Model

Desktop Intelligence auto-loads the model on launch. However, you can pre-load it manually to confirm everything works:

1. In LM Studio, go to the **Local Server** tab
2. Under **"Load a model to use it"**, select `mlx-community/Qwen3.5-35B-A3B-6bit`
3. Wait for the model to load (~30–60 seconds on first load)

---

## Step 4 — Install Desktop Intelligence

### Option A — Use the Pre-built DMG (Recommended)

1. Download `Desktop Intelligence-1.0.0-arm64.dmg` from the releases
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
2. The app will automatically:
   - Start the LM Studio server (if not already running)
   - Load `mlx-community/Qwen3.5-35B-A3B-6bit` with `lms load`
   - Begin health-checking the connection
3. You'll see a connection overlay while the model loads. On first launch this takes **30–60 seconds**
4. Once the overlay clears, you're ready to chat

---

## Step 6 — Set Your Context Length (Optional)

The model's context window controls how much conversation history it can see. The default is 32K tokens, which is comfortable for most conversations. For long document analysis or extended conversations, you may want more.

1. Click the **⚙️** (cog icon) in the bottom-left of the sidebar
2. Adjust the **Context Length** slider — recommended values:
   - **32K** (32 768) — default, good for general use
   - **64K** (65 536) — good for document Q&A and long conversations
   - **128K** (131 072) — maximum; uses significantly more RAM
3. Click **Reload Model** and wait ~30–60 seconds
4. Your preference is saved and applied automatically on every future launch

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
- Make sure you downloaded the **MLX** version of the model (`mlx-community/Qwen3.5-35B-A3B-6bit`), not a GGUF or other format

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

*Last updated: 2026-03-30*
