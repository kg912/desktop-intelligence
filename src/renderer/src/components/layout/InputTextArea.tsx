
import {
    type KeyboardEvent,
} from 'react'
import { cn } from '../../lib/utils'
import { Signal } from '@preact/signals-react'
import { useSignals } from '@preact/signals-react/runtime'

// ----------------------------------------------------------------
// InputBar
// ----------------------------------------------------------------
export interface InputTextAreaProps {
    handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
    textareaRef: React.RefObject<HTMLTextAreaElement>
    textAreaSignal: Signal<string>
}

const MAX_TEXTAREA_HEIGHT = 200
const MIN_TEXTAREA_HEIGHT = 24

export const InputTextArea = ({ textareaRef, handleKeyDown, textAreaSignal }: InputTextAreaProps) => {
    useSignals();
    return (
        <textarea
            ref={textareaRef}
            value={textAreaSignal.value}
            onChange={(e) => {
                textAreaSignal.value = e.target.value
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message… (Shift+Enter for newline)"
            rows={1}
            className={cn(
                'flex-1 resize-none bg-transparent',
                'text-sm text-content-primary placeholder:text-content-muted',
                'focus:outline-none leading-6 py-px selectable'
            )}
            style={{
                height: MIN_TEXTAREA_HEIGHT,
                maxHeight: MAX_TEXTAREA_HEIGHT,
                fontFamily: 'inherit',
                overflowY: 'hidden'
            }}
        />)
}