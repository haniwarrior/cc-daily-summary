import { loadConfig } from './config.js';
import { createSession, targetTimelines } from './publish.js';
import { runDailyJob } from './job.js';
import { runSchedule } from './schedule.js';
import { errorLabel } from './retry.js';

async function main() {
  let config;
  try { config = loadConfig(); }
  catch (error) {
    console.error(`設定エラー: ${error instanceof Error ? error.message : '設定を確認してください。'}`);
    process.exitCode = 1;
    return;
  }
  console.log('Application started');
  const ccid = createSession(config).ccid;
  const [home, ...additional] = targetTimelines(ccid, config.postTimelines);
  console.log(`Subkey owner CCID: ${ccid}`);
  console.log(`Home Timeline: ${home}`);
  console.log(`Additional Timelines: ${additional.length ? additional.join(', ') : '(none)'}`);
  try {
    if (process.argv.includes('--once')) await runDailyJob(config);
    else await runSchedule(config.postTime, config.timezone, () => runDailyJob(config));
  } catch (error) {
    console.error(`Final failure: ${errorLabel(error)}`);
    process.exitCode = 1;
  }
}
await main();
