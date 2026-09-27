import { Temporal } from '@js-temporal/polyfill';

export function nextRun(now: Temporal.Instant, postTime: string, timezone: string): Temporal.Instant {
  let date = now.toZonedDateTimeISO(timezone).toPlainDate();
  for (;;) {
    // DSTの存在しない時刻は後へ、重複時刻は最初へ（Temporal compatible）。
    const scheduled = date.toPlainDateTime(Temporal.PlainTime.from(postTime)).toZonedDateTime(timezone).toInstant();
    if (Temporal.Instant.compare(scheduled, now) > 0) return scheduled;
    date = date.add({ days: 1 });
  }
}

export async function runSchedule(postTime: string, timezone: string, job: () => Promise<void>): Promise<never> {
  let lastDate: string | undefined;
  for (;;) {
    let now = Temporal.Now.instant();
    if (now.toZonedDateTimeISO(timezone).toPlainDate().toString() === lastDate) {
      now = now.toZonedDateTimeISO(timezone).startOfDay().add({ days: 1 }).toInstant().subtract({ nanoseconds: 1 });
    }
    const target = nextRun(now, postTime, timezone);
    console.log(`Next run: ${target.toZonedDateTimeISO(timezone).toString()}`);
    while (Temporal.Instant.compare(Temporal.Now.instant(), target) < 0) {
      const ms = target.epochMilliseconds - Temporal.Now.instant().epochMilliseconds;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(ms, 30_000))));
    }
    lastDate = Temporal.Now.instant().toZonedDateTimeISO(timezone).toPlainDate().toString();
    // 待ってから次回を計算するため同時実行なし。最終失敗は終了。
    await job();
  }
}
