import type { AugmentLogEntry } from '../types.js';

export class AugmentLog {
  private entries: AugmentLogEntry[] = [];
  constructor(private capacity = 200) {}

  record(entry: AugmentLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  recent(limit = 50): AugmentLogEntry[] {
    const n = Math.max(1, Math.min(limit, this.capacity));
    return this.entries.slice(-n).reverse();
  }

  clear(): void {
    this.entries = [];
  }
}
