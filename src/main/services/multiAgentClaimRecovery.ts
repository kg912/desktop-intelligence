// Rectification R4: reads a run's log for the claims and tool results older traces lack (see shared/claimRecovery.ts).
import { promises as fs } from 'fs'
import path from 'path'
import type { EvidenceRecord, MultiAgentRunRecord } from '../../shared/types'
import { agentsMissingClaims, evidenceFromRecords, evidenceOwner, withClaimsFromRecords } from '../../shared/claimRecovery'
import type { LogRecord } from '../../shared/claimRecovery'
import { parseJsonl, recordFile } from './MultiAgentRunLogger'

export { claimsFromReply } from '../../shared/claimRecovery'

async function agentRecords(runDir: string, agentId: string): Promise<LogRecord[]> {
  const text = await fs.readFile(path.join(runDir, `${recordFile({ role: 'worker', agentId })}.jsonl`), 'utf8').catch(() => '')
  return parseJsonl<LogRecord>(text)
}

/** The saved run with its gates' claims filled from the run log when they were never stored; the same object otherwise. */
export async function withRecoveredClaims(record: MultiAgentRunRecord, runDir: string): Promise<MultiAgentRunRecord> {
  const agents = agentsMissingClaims(record)
  if (!agents.length) return record
  const records = new Map(await Promise.all(agents.map(async (id) => [id, await agentRecords(runDir, id)] as const)))
  return withClaimsFromRecords(record, (id) => records.get(id) ?? [])
}

/** A cited tool result from the run log; "1.2/<callId>" reads 1.2's. */
export async function evidenceFromLog(runDir: string, agentId: string, callId: string): Promise<EvidenceRecord | null> {
  const [owner, id] = evidenceOwner(agentId, callId)
  return evidenceFromRecords(await agentRecords(runDir, owner), owner, id)
}
