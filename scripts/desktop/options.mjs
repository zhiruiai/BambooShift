export function parseClientArguments(
  argv,
  host = { platform: process.platform, arch: process.arch },
) {
  const options = {
    platform: host.platform,
    arch: host.arch,
    help: false,
    dryRun: false,
    withRuntime: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const [flag, ...rest] = argv[index].split('=');
    if (seen.has(flag)) throw new Error(`参数重复：${flag}`);
    seen.add(flag);
    if (['--help', '-h', '--dry-run', '--with-runtime'].includes(flag)) {
      if (rest.length) throw new Error(`${flag} 不接受参数值。`);
      const key = flag === '--dry-run' ? 'dryRun' : flag === '--with-runtime' ? 'withRuntime' : 'help';
      options[key] = true;
    } else if (flag === '--platform' || flag === '--arch') {
      const value = rest.length ? rest.join('=') : argv[++index];
      if (!value || value.startsWith('-')) throw new Error(`${flag} 缺少参数值。`);
      options[flag.slice(2)] = value;
    } else throw new Error(`未知参数：${argv[index]}。运行 --help 查看用法。`);
  }
  if (!options.help && !['darwin', 'win32', 'linux'].includes(options.platform))
    throw new Error('--platform 只支持 darwin、win32、linux。');
  if (!options.help && !['arm64', 'x64'].includes(options.arch))
    throw new Error('--arch 只支持 arm64、x64。');
  if (!options.help && options.withRuntime && (
    options.platform === 'win32' || options.platform !== host.platform || options.arch !== host.arch
  )) throw new Error('内置服务必须在目标 macOS 或 Linux 系统及相同架构上构建。');
  return options;
}
