// Sandbox service singleton — created once at module load time.
// Both PythonWorkerService and index.ts share this instance.
// The SrtBackend is the active backend; MicrosandboxBackend is a stub
// until the Phase 4 benchmark gate passes.

import { SrtBackend } from './SrtBackend'
import { MicrosandboxBackend } from './MicrosandboxBackend'
import { SandboxService } from '../SandboxService'

export const srtBackend = new SrtBackend()
const microsandboxBackend = new MicrosandboxBackend()
export const sandboxService = new SandboxService(srtBackend, microsandboxBackend)