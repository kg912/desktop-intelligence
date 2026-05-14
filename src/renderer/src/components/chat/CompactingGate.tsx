import { useSignals } from '@preact/signals-react/runtime'
import { isCompactingSignal } from '../../store/ModelStore'
import { CompactProgressOverlay } from './CompactProgressOverlay'

interface Props {
  isReloading: boolean
}

export function CompactingGate({ isReloading }: Props) {
  useSignals()
  const isCompacting = isCompactingSignal.value
  if (!isCompacting && !isReloading) return null
  return (
    <CompactProgressOverlay
      label={isReloading ? 'Reloading model…' : 'Compacting context…'}
    />
  )
}
