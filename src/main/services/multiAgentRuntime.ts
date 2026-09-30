// Process-wide handle to the multi-agent run coordinator. index.ts creates it
// once its dependencies (window, sidecar, MCP) exist; IPC handlers use it.
import type { MultiAgentRunCoordinator } from './MultiAgentRunCoordinator'

let coordinator: MultiAgentRunCoordinator | null = null

export function setMultiAgentCoordinator(next: MultiAgentRunCoordinator): void {
  coordinator = next
}

export function getMultiAgentCoordinator(): MultiAgentRunCoordinator {
  if (!coordinator) throw new Error('Multi-agent orchestration is not initialised yet')
  return coordinator
}
