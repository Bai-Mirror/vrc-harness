// `npm test`: the unit suite with the shared per-test budget and the stall supervisor from `unit-suite.mjs`, so a
// developer's run is bounded the same way the full check is. This launcher and `unit-suite.mjs` are named so that
// `node --test`'s own file discovery does not treat either of them as a test file and run the suite twice.
import { superviseSuite, unitTestArgs } from './unit-suite.mjs';

const result = await superviseSuite(unitTestArgs(process.argv.slice(2)), { onOutput: text => process.stdout.write(text) });
if (result.stalled) {
  console.error(`\n单元测试已停止：${result.stalled}。\n最后看到的输出：\n${result.tail.slice(-20).join('\n')}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
