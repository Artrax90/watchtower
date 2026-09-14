const snoozeMap = new Map<string, number>();

export const snoozeManager = {
  snooze(monitorId: string, minutes: number): number {
    const until = Date.now() + minutes * 60 * 1000;
    snoozeMap.set(monitorId, until);
    return until;
  },

  unsnooze(monitorId: string) {
    snoozeMap.delete(monitorId);
  },

  isSnoozed(monitorId: string): boolean {
    const until = snoozeMap.get(monitorId);
    if (!until) return false;
    if (Date.now() >= until) {
      snoozeMap.delete(monitorId);
      return false;
    }
    return true;
  },

  getSnoozeRemaining(monitorId: string): number {
    const until = snoozeMap.get(monitorId);
    if (!until) return 0;
    const remaining = Math.max(0, until - Date.now());
    if (remaining === 0) {
      snoozeMap.delete(monitorId);
    }
    return remaining;
  }
};
