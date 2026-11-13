import { isBuiltin } from 'node:module';

export function packageName(specifier) {
  if (isBuiltin(specifier)) return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('\\'))
    throw Error(`A runtime import was not bundled: ${specifier}`);
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Project the verified root lock graph without asking a registry to resolve new versions. */
export function productionLock(source, directNames) {
  if (source.lockfileVersion !== 3 || !source.packages?.[''])
    throw Error('A version 3 npm lockfile is required.');
  const version = source.packages[''].version;
  if (typeof version !== 'string' || !version)
    throw Error('The root npm lockfile must identify the project version.');
  const dependencies = {};
  for (const name of [...new Set(directNames)].sort()) {
    const entry = source.packages[`node_modules/${name}`];
    if (!entry?.version || !entry.integrity)
      throw Error(`Missing pinned worker dependency: ${name}`);
    dependencies[name] = entry.version;
  }
  const manifest = {
    name: 'openbot-runtime-workers',
    version,
    private: true,
    type: 'module',
    engines: { node: '>=22.19.0' },
    dependencies,
  };
  if (source.packages[''].overrides)
    manifest.overrides = structuredClone(source.packages[''].overrides);
  const packages = { '': structuredClone(manifest) };
  delete packages[''].type;
  delete packages[''].private;
  const resolveDependency = (from, name) => {
    let parent = from;
    for (;;) {
      const key = `${parent ? parent + '/' : ''}node_modules/${name}`;
      if (source.packages[key]) return key;
      if (!parent) return undefined;
      const at = parent.lastIndexOf('/node_modules/');
      parent = at < 0 ? '' : parent.slice(0, at);
    }
  };
  const pending = Object.keys(dependencies).map((name) => [`node_modules/${name}`, false]);
  while (pending.length) {
    const [key, optionalPath] = pending.pop();
    // A package first reached through an optional edge may later be required.
    // Revisit its descendants as well; root-lock flags describe a different graph.
    if (packages[key] && (!packages[key].optional || optionalPath)) continue;
    const sourceEntry = source.packages[key];
    if (!sourceEntry || sourceEntry.link || !sourceEntry.version || !sourceEntry.integrity)
      throw Error(`An unpinned runtime dependency cannot be published: ${key}`);
    if (sourceEntry.resolved) {
      const url = new URL(sourceEntry.resolved);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw Error(`A private or non-registry dependency cannot be published: ${key}`);
    }
    const entry = structuredClone(sourceEntry);
    delete entry.dev;
    delete entry.devOptional;
    if (optionalPath) entry.optional = true;
    else delete entry.optional;
    packages[key] = entry;
    for (const [name] of Object.entries({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    })) {
      const target = resolveDependency(key, name);
      const optional =
        Object.hasOwn(entry.optionalDependencies ?? {}, name) ||
        entry.peerDependenciesMeta?.[name]?.optional;
      if (target) pending.push([target, optionalPath || optional]);
      else if (!optional) throw Error(`The root lock is missing ${name} required by ${key}`);
    }
  }
  return {
    manifest,
    lock: {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
  };
}
