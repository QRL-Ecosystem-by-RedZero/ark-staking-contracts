const hypc = require('@theqrl/hypc');
const src = process.argv[2];
const input = {
  language: 'Hyperion',
  sources: { 'P.hyp': { content: require('fs').readFileSync(src, 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'zvm.bytecode.object'] } } },
};
const out = JSON.parse(hypc.compile(JSON.stringify(input)));
let bad = false;
for (const e of out.errors || []) {
  if (e.severity === 'error') { bad = true; console.log('ERROR:', e.formattedMessage.split('\n')[0]); }
  else if (!/SPDX/.test(e.formattedMessage)) console.log('warn :', e.formattedMessage.split('\n')[0]);
}
console.log(bad ? '=> FAIL' : '=> OK');
