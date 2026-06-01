import { useState, useCallback } from "react";
import { Settings, Globe, Info, Plug, Server, Bug } from "lucide-react";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { MCPSettingsPanel } from "./MCPSettingsPanel";
import { McpToolsPanel } from "./McpToolsPanel";
import { InferenceProviderSettingsPanel } from "./InferenceProviderSettingsPanel";
import { DebugSettings } from "./DebugSettings";
import { cn } from "../../lib/utils";
import { version, author } from "../../../../../package.json";

type SettingsTab = "model" | "websearch" | "tools" | "backend" | "debug" | "about";

interface SettingsPageProps {
  onClose: () => void;
  // Called by ModelSettingsPanel to report that a reload is in-flight,
  // so the X button is blocked while lms unload→load is running.
  onReloadingChange?: (reloading: boolean) => void;
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
        "group relative flex items-center gap-2.5 w-full px-3 py-[11px] rounded-lg cursor-pointer",
        "text-left overflow-hidden",
        active
          ? "bg-accent-950/60 border border-accent-900/40"
          : "border border-transparent bg-transparent before:content-[''] before:absolute before:inset-0 before:bg-surface-hover before:opacity-0 hover:before:opacity-100 before:transition-opacity before:duration-100 before:pointer-events-none before:rounded-lg before:z-0 before:will-change-[opacity]",
      )}
    >
      <span
        className={cn(
          "relative z-10 flex-shrink-0 w-3.5 h-3.5",
          active
            ? "text-accent-500"
            : "text-content-muted group-hover:text-content-secondary transition-colors duration-100",
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "relative z-10 text-sm font-medium",
          active
            ? "text-content-primary"
            : "text-content-secondary group-hover:text-content-primary transition-colors duration-100",
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
          One Interface. Every model.
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

export function SettingsPage({ onClose, onReloadingChange }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("model");
  // Track whether ModelSettingsPanel is mid-reload so we block the X.
  const [isReloading, setIsReloading] = useState(false);

  const handleReloadingChange = useCallback((r: boolean) => {
    setIsReloading(r);
    onReloadingChange?.(r);
  }, [onReloadingChange]);

  const safeClose = useCallback(() => {
    if (isReloading) return;
    onClose();
  }, [isReloading, onClose]);

  const paddingTop = tab === "about" ? 160 : tab === "tools" ? 40 : tab === "backend" ? 60 : tab === "debug" ? 60 : 60;

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
            onClick={safeClose}
            disabled={isReloading}
            className={isReloading
              ? "text-content-muted/30 cursor-not-allowed text-lg leading-none"
              : "text-content-muted hover:text-white transition-colors text-lg leading-none"}
            aria-label={isReloading ? "Cannot close while reloading model" : "Close settings"}
            title={isReloading ? "Wait for model reload to finish" : undefined}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            ✕
          </button>
        </div>
        {/* Nav items — same top offset as content panel */}
        <nav className="px-2" style={{ paddingTop: 160 }}>
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
            icon={<Server size={15} />}
            label="Backend"
            active={tab === "backend"}
            onClick={() => setTab("backend")}
          />
          <TabItem
            icon={<Bug size={15} />}
            label="Debug"
            active={tab === "debug"}
            onClick={() => setTab("debug")}
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
          {tab === "model"     && <ModelSettingsPanel onReloadingChange={handleReloadingChange} />}
          {tab === "websearch" && <MCPSettingsPanel />}
          {tab === "tools"     && <McpToolsPanel />}
          {tab === "backend"   && <InferenceProviderSettingsPanel />}
          {tab === "debug"     && <DebugSettings />}
          {tab === "about"     && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}
