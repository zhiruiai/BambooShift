// Some official SDKs write transport errors directly to console. In the dedicated
// CLI process only, discard their arguments: Error objects can contain credentials.
export function shieldSdkConsole(report) {
  const methods = ['debug', 'log', 'info', 'warn', 'error', 'trace'];
  const original = new Map(methods.map((method) => [method, console[method]]));
  let last = 0;
  for (const method of methods)
    console[method] = () => {
      if (['warn', 'error'].includes(method) && Date.now() - last > 1000) {
        last = Date.now();
        report({ status: 'sdk-diagnostic', level: method });
      }
    };
  return () => {
    for (const [method, value] of original) console[method] = value;
  };
}
