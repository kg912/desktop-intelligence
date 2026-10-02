/**
 * Checks every multi-agent run log under a directory (default: the app's
 * observability-logs/multi-agent) with verifyRunDir. Optional: pass credentials
 * to search for as extra arguments. Exit 1 on any problem.
 *   npx tsx scripts/check-run-logs.ts ~/Library/Application\ Support/<app>/observability-logs/multi-agent [secret ...]
 */
import { MultiAgentRunLogger, verifyRunDir } from '../src/main/services/MultiAgentRunLogger'

async function main(): Promise<number> {
  const [root, ...secrets] = process.argv.slice(2)
  if (!root) {
    console.error('usage: check-run-logs.ts <multi-agent log root> [secret ...]')
    return 2
  }
  const runs = await new MultiAgentRunLogger(root, { secrets: () => [] }).listRuns()
  let bad = 0
  for (const run of runs) {
    const problems = run.status === 'incomplete' ? ['run did not finish (status incomplete)'] : await verifyRunDir(run.dir, secrets)
    if (problems.length) bad++
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${run.runId} ${run.chatTitle}`)
    for (const p of problems) console.log(`     - ${p}`)
  }
  console.log(`${runs.length - bad}/${runs.length} runs consistent`)
  return bad ? 1 : 0
}

main().then((code) => process.exit(code))
