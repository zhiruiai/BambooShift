import { currentLanguage } from '../../i18n';
import '../ComputerFiles.css';
export function parentPath(path: string) {
  const parts = path.split('/').filter((part) => part && part !== '.');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
}
export function modifiedTime(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  return new Date(value).toLocaleString(currentLanguage(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
