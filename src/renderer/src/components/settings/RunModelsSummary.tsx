import { MODEL_ROLES, resolveRoleModels, type ModelRole, type ModelSource } from '../../../../shared/multiAgentModels'
import type { MultiAgentConfig } from '../../../../shared/types'

const ROLE_LABEL: Record<ModelRole, string> = {
  orchestrator: 'Orchestrator',
  worker: 'Worker agents',
  reflection: 'Reflection',
  synthesizer: 'Synthesizer',
}

const SOURCE: Record<ModelSource, { label: string; className: string }> = {
  saved: { label: 'saved', className: 'text-ma-ok border-ma-ok/30 bg-ma-ok/10' },
  default: { label: 'default', className: 'text-ma-mute border-white/[0.09]' },
  active: { label: 'follows active model', className: 'text-ma-mute border-white/[0.09]' },
  missing: { label: 'not in catalogue · run will not start', className: 'text-ma-amber border-ma-amber/30 bg-ma-amber/10' },
}

/**
 * "Models the next run will use" (designs/03-settings.html). Uses the same
 * resolveRoleModels rule as the run start, so it cannot disagree with it.
 * `catalogueIds` null = catalogue not loaded: ids are shown unverified.
 */
export function RunModelsSummary({ models, activeModel, catalogueIds }: {
  models: MultiAgentConfig['models']
  activeModel: string
  catalogueIds: ReadonlySet<string> | null
}) {
  const resolved = resolveRoleModels(models, activeModel, catalogueIds)
  return (
    <section aria-label="Models the next run will use" className="overflow-hidden rounded-xl border-[0.5px] border-white/[0.09] bg-ma-bg1">
      <div className="flex justify-between border-b-[0.5px] border-white/5 px-4 py-3 text-[13px] text-ma-text">
        <span>Models the next run will use</span>
        <span className="text-ma-mute">Active OpenRouter model: {activeModel || 'none selected'}</span>
      </div>
      {MODEL_ROLES.map((role) => {
        const { model, source } = resolved[role]
        return (
          <div key={role} data-testid={`run-model-${role}`} className="grid grid-cols-[130px_1fr_auto] items-center gap-3 border-b-[0.5px] border-white/5 px-4 py-2.5 text-[13px] last:border-0">
            <span className="text-ma-mute">{ROLE_LABEL[role]}</span>
            <span className="truncate font-mono text-[12.5px] text-ma-text">{model || '—'}</span>
            <span className={`inline-flex h-5 items-center rounded-[5px] border-[0.5px] px-[7px] font-mono text-[11.5px] ${SOURCE[source].className}`}>
              {SOURCE[source].label}
            </span>
          </div>
        )
      })}
    </section>
  )
}
