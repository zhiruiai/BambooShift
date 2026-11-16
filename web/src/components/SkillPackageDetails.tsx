import { Download } from 'lucide-react';
import type { AgentSkillFrontmatter } from '../../../shared/types';
import { formatNumber, uiText } from '../i18n';
import { workspaceApiUrl } from '../workspace-scope';
import './SkillVersions.css';

export function SkillPackageDetails({
  root,
  frontmatter,
  files,
  fileContents,
  skillId,
  expandedFiles = false,
}: {
  root: string;
  frontmatter: AgentSkillFrontmatter;
  files: { path: string; size?: number }[];
  fileContents?: Readonly<Record<string, string>>;
  skillId?: string;
  expandedFiles?: boolean;
}) {
  const fields = [
    [uiText('common:skillPackageLicense'), frontmatter.license],
    [uiText('common:skillPackageCompatibility'), frontmatter.compatibility],
    [uiText('common:skillPackageTools'), frontmatter['allowed-tools']],
    ...Object.entries(frontmatter.metadata ?? {}),
  ].filter(([, value]) => value !== undefined);
  const metadata = (
    <dl>
      {fields.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section className="skill-package" aria-label={uiText('common:skillPackageTitle')}>
      <strong>{uiText('common:skillPackageTitle')}</strong>
      <code>{root}/</code>
      {fields.length > 0 && !expandedFiles && metadata}
      <details open={fileContents || expandedFiles ? true : undefined}>
        <summary>{uiText('common:skillPackageFiles', { count: files.length })}</summary>
        <ul>
          {files.map(({ path, size }) => {
            const filename = (
              <>
                <code>{path}</code>
                {size !== undefined && (
                  <small>
                    {uiText('common:skillPackageFileSize', { size: formatNumber(size) })}
                  </small>
                )}
              </>
            );
            return (
              <li key={path}>
                {fileContents && Object.hasOwn(fileContents, path) ? (
                  <details className="skill-package-file">
                    <summary>{filename}</summary>
                    <pre>{fileContents[path]}</pre>
                  </details>
                ) : (
                  filename
                )}
              </li>
            );
          })}
        </ul>
      </details>
      {skillId && (
        <a
          className="secondary-button"
          href={workspaceApiUrl(`/api/skills/${encodeURIComponent(skillId)}/package`)}
          download={`${root}.zip`}
        >
          <Download size={14} aria-hidden="true" />
          {uiText('common:skillPackageDownload')}
        </a>
      )}
      {fields.length > 0 && expandedFiles && (
        <details>
          <summary>{uiText('common:skillPackageMetadata')}</summary>
          {metadata}
        </details>
      )}
    </section>
  );
}
