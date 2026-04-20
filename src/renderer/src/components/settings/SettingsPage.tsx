import { useState } from "react";
import { Settings, Globe, Info, Plug } from "lucide-react";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { MCPSettingsPanel } from "./MCPSettingsPanel";
import { McpToolsPanel } from "./McpToolsPanel";
import { cn } from "../../lib/utils";
import { version, author } from "../../../../../package.json";

type SettingsTab = "model" | "websearch" | "tools" | "about";

interface SettingsPageProps {
  onClose: () => void;
}

function TabItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg cursor-pointer",
        "transition-colors duration-100 text-left",
        active
          ? "bg-accent-950/60 border border-accent-900/40"
          : "hover:bg-surface-hover border border-transparent",
      )}
    >
      <span
        className={cn(
          "flex-shrink-0 w-3.5 h-3.5",
          active ? "text-accent-500" : "text-content-muted",
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "text-sm font-medium",
          active ? "text-content-primary" : "text-content-secondary",
        )}
      >
        {label}
      </span>
    </button>
  );
}

function AboutPanel() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-content-primary mb-1">
          Desktop Intelligence
        </h2>
        <p className="text-sm text-content-muted">
          Local Inference. Zero Latency.
        </p>
      </div>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between py-2.5 border-b border-surface-border/30">
          <span className="text-content-secondary">Version</span>
          <span className="text-content-primary font-mono">{version}</span>
        </div>
        <div className="flex items-center justify-between py-2.5 border-b border-surface-border/30">
          <span className="text-content-secondary">Author</span>
          <span className="text-content-primary">{author}</span>
        </div>
        <div className="flex items-center justify-between py-2.5">
          <span className="text-content-secondary">Changelog</span>
          <a
            href="https://github.com/kg912/desktop-intelligence/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-500 hover:text-accent-400 transition-colors underline underline-offset-2"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("model");

  const paddingTop = tab === "about" ? 160 : tab === "tools" ? 40 : 60;

  return (
    <div className="flex h-full w-full" style={{ background: "#0f0f0f" }}>
      {/* Left nav */}
      <div
        className="flex flex-col"
        style={{
          width: 260,
          background: "#111",
          borderRight: "1px solid #1f1f1f",
          flexShrink: 0,
        }}
      >
        {/* Extra left padding clears macOS traffic light buttons (~70px wide at x=16) */}
        <div
          className="flex items-center justify-between border-b border-surface-border/30"
          style={
            {
              paddingTop: 18,
              paddingBottom: 14,
              paddingLeft: 80,
              paddingRight: 16,
              WebkitAppRegion: "drag",
            } as React.CSSProperties
          }
        >
          <span
            className="text-sm font-semibold text-white"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            Settings
          </span>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-white transition-colors text-lg leading-none"
            aria-label="Close settings"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            ✕
          </button>
        </div>
        {/* Nav items — same top offset as content panel */}
        <nav className="space-y-0.5 px-2" style={{ paddingTop: 160 }}>
          <TabItem
            icon={<Settings size={15} />}
            label="Model"
            active={tab === "model"}
            onClick={() => setTab("model")}
          />
          <TabItem
            icon={<Globe size={15} />}
            label="Web Search"
            active={tab === "websearch"}
            onClick={() => setTab("websearch")}
          />
          <TabItem
            icon={<Plug size={15} />}
            label="MCP Servers"
            active={tab === "tools"}
            onClick={() => setTab("tools")}
          />
          <TabItem
            icon={<Info size={15} />}
            label="About"
            active={tab === "about"}
            onClick={() => setTab("about")}
          />
        </nav>
      </div>

      {/* Content — same top offset as nav, horizontally centred inner block */}
      <div className="flex-1 overflow-y-auto">
        <div
          className="mx-auto px-12 pb-8 w-full"
          style={{ maxWidth: 720, paddingTop }}
        >
          {tab === "model"     && <ModelSettingsPanel />}
          {tab === "websearch" && <MCPSettingsPanel />}
          {tab === "tools"     && <McpToolsPanel />}
          {tab === "about"     && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}
