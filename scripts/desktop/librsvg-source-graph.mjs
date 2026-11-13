import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Summarize `cargo tree -p librsvg-c -e normal,build --prefix depth` without host paths. */
export function summarizeLibrsvgTree(text, catalog) {
  if (text.length > 8 * 1024 * 1024 || !Array.isArray(catalog.packages))
    throw Error('Invalid or oversized source graph inputs.');
  const sources = new Map(catalog.packages.map((item) => [`${item.name}@${item.version}`, item]));
  const selected = new Map(),
    edges = new Set(),
    parents = [];
  for (const line of text.trim().split('\n')) {
    const match =
      /^(\d+)([A-Za-z0-9_-]+) v([0-9A-Za-z.+-]+)(?: \([^|]*\))?\|features=([A-Za-z0-9_,+.-]*)(?: \(\*\))?$/.exec(
        line,
      );
    if (!match) throw Error('Unexpected Cargo tree format.');
    const [, depthText, name, version, featureText] = match;
    const depth = Number(depthText),
      id = `${name}@${version}`;
    if (depth > parents.length || (!selected.size && (depth !== 0 || id !== 'librsvg-c@2.63.2')))
      throw Error('The graph must begin at the selected librsvg-c library.');
    if (selected.size && depth === 0) throw Error('Unexpected additional workspace root.');
    const source = sources.get(id);
    if (!source && !['librsvg-c@2.63.2', 'librsvg@2.63.2'].includes(id))
      throw Error(`Unverified source publication: ${id}.`);
    if (
      source &&
      (source.sourceUrl !== `https://static.crates.io/crates/${name}/${name}-${version}.crate` ||
        !/^[a-f0-9]{64}$/.test(source.sourceSha256))
    )
      throw Error(`Source identity is not checksum-bound: ${id}.`);
    const record = selected.get(id) ?? {
      id,
      features: new Set(),
      ...(source
        ? { sourceUrl: source.sourceUrl, sourceSha256: source.sourceSha256 }
        : { workspace: true }),
    };
    for (const feature of featureText.split(',').filter(Boolean)) record.features.add(feature);
    selected.set(id, record);
    if (depth) edges.add(`${parents[depth - 1]}>${id}`);
    parents[depth] = id;
    parents.length = depth + 1;
  }
  const packages = [...selected.values()]
    .map((record) => ({
      ...record,
      features: [...record.features].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    root: 'librsvg-c@2.63.2',
    scope:
      'Resolved normal/build source graph; not a final linked-code SBOM or redistribution approval.',
    registryPackages: packages.filter((record) => !record.workspace).length,
    packages,
    edges: [...edges].sort().map((edge) => edge.split('>')),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [treePath, outputPath, ...extra] = process.argv.slice(2);
  if (!treePath || !outputPath || extra.length)
    throw Error('Usage: node scripts/desktop/librsvg-source-graph.mjs TREE OUTPUT');
  const reviewed = JSON.parse(
    await readFile(
      new URL('../../legal/third-party/sharp-libvips-1.3.4/TARGET-GRAPHS.json', import.meta.url),
    ),
  );
  const packages = Object.entries(reviewed.registrySources).map(([id, source]) => {
    const [name, version] = id.split('@');
    return { name, version, ...source };
  });
  const graph = summarizeLibrsvgTree(await readFile(treePath, 'utf8'), { packages });
  await writeFile(outputPath, JSON.stringify(graph, null, 2) + '\n', { flag: 'wx' });
  console.log(`Recorded ${graph.registryPackages} checksum-bound registry source candidates.`);
}
