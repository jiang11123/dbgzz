export class DownloadTracker {
  private readonly active = new Map<string, number>();

  keyFor(accountId: number, sourceUrl: string) {
    return `${accountId}:${sourceUrl}`;
  }

  begin(accountId: number, sourceUrl: string, allowDuplicate = false) {
    const key = this.keyFor(accountId, sourceUrl);
    if (this.active.has(key) && !allowDuplicate) return false;
    this.active.set(key, (this.active.get(key) || 0) + 1);
    return true;
  }

  finish(accountId: number, sourceUrl: string) {
    const key = this.keyFor(accountId, sourceUrl);
    const remaining = (this.active.get(key) || 0) - 1;
    if (remaining > 0) this.active.set(key, remaining);
    else this.active.delete(key);
  }
}
