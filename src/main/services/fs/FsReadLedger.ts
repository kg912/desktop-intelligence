// Read ledger (spec 2.4): which file versions each chat has read, so fs_edit /
// fs_write refuse to change a file the model has not seen or that changed since.

export interface LedgerEntry {
  sha256: string
  mtimeMs: number
  size: number
}

export class FsReadLedger {
  private entries = new Map<string, Map<string, LedgerEntry>>()

  record(chatId: string, realPath: string, entry: LedgerEntry): void {
    let m = this.entries.get(chatId)
    if (!m) this.entries.set(chatId, (m = new Map()))
    m.set(realPath, entry)
  }

  get(chatId: string, realPath: string): LedgerEntry | undefined {
    return this.entries.get(chatId)?.get(realPath)
  }

  clearChat(chatId: string): void {
    this.entries.delete(chatId)
  }
}
