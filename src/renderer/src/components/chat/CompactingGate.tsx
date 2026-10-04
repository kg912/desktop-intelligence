import { isCompactingSignal } from '../../store/ModelStore'
import { CompactProgressOverlay } from './CompactProgressOverlay'

interface Props {
  isReloading: boolean
}

export function CompactingGate({ isReloading }: Props) {
  const isCompacting = isCompactingSignal.value
  if (!isCompacting && !isReloading) return null
  return (
    <CompactProgressOverlay
      label={isReloading ? 'Reloading model…' : 'Compacting context…'}
    />
  )
}
