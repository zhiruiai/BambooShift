import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionTag = /^v0\.0\.([1-9]\d{0,6})$/;
const sourceId = /^[a-f0-9]{40}$/;
const shanghaiDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function releaseDay(timestamp) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) throw Error('Invalid release timestamp.');
  return shanghaiDay.format(date);
}

export function planRelease({ startedAt, source, releases, tagLines }) {
  if (!sourceId.test(source)) throw Error('Invalid source revision.');
  const day = releaseDay(startedAt);
  const published = releases.filter(
    (release) => !release.draft && !release.prerelease && versionTag.test(release.tag_name),
  );
  if (published.some((release) => releaseDay(release.published_at) >= day))
    return { publish: false };

  const patch = 1 + Math.max(0, ...published.map((release) => Number(release.tag_name.split('.')[2])));
  const version = `0.0.${patch}`;
  const tag = `v${version}`;
  if (!versionTag.test(tag)) throw Error('The automatic release series is exhausted.');
  const sameTag = releases.filter(
    (release) => release.tag_name === tag ||
      (release.draft && [`MosoCrew ${tag}`, `PandaMate ${tag}`].includes(release.name)),
  );
  if (sameTag.length > 1 || sameTag.some((release) => !release.draft))
    throw Error('The next version is reserved by another release.');

  const previousTag = tagLines
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([name]) => name === tag);
  if (previousTag) {
    const [, type, subject] = previousTag;
    const original = /^(?:MosoCrew|PandaMate) release from ([a-f0-9]{40})$/.exec(subject)?.[1];
    if (type !== 'tag' || !original) throw Error('The next tag was not created by this workflow.');
    source = original;
  }
  const draft = sameTag[0];
  if (draft && (!previousTag || !draft.body?.includes(`<!-- pandamate-source: ${source} -->`)))
    throw Error('The next draft does not match the release snapshot.');

  return { publish: true, version, tag, source, day };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [startedAt, source, releaseList, tagList] = process.argv.slice(2);
  const releases = JSON.parse(readFileSync(releaseList, 'utf8')).flat();
  const tagLines = readFileSync(tagList, 'utf8');
  const plan = planRelease({ startedAt, source, releases, tagLines });
  for (const [key, value] of Object.entries(plan))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
