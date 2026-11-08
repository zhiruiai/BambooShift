import { currentLanguage } from './i18n';
import { uiText, localizedData } from './i18n';
import { DEFAULT_TIME_ZONE, effectiveTimeZone, normalizeTimeZone } from '../../shared/time-zone';

const cities: Record<string, string> = localizedData(() => ({
  'Asia/Shanghai': uiText('settings:text_5a7dbc3e0146'),
  'Asia/Hong_Kong': uiText('settings:text_d448d143c4e0'),
  'Asia/Taipei': uiText('settings:text_b4415237de73'),
  'Asia/Tokyo': uiText('settings:text_95b3ec132e6e'),
  'Asia/Singapore': uiText('settings:text_f98b2fc82a45'),
  'Asia/Kolkata': uiText('settings:text_fd41ccf56290'),
  'Asia/Dubai': uiText('settings:text_655503466936'),
  'Europe/London': uiText('settings:text_a6c0db788b58'),
  'Europe/Paris': uiText('settings:text_089dd4929e65'),
  'America/New_York': uiText('settings:text_21f9f830edf1'),
  'America/Chicago': uiText('settings:text_6de99512acbf'),
  'America/Los_Angeles': uiText('settings:text_bd12e7ddfed2'),
  'Australia/Sydney': uiText('settings:text_40a5bd6e30cb'),
  'Pacific/Auckland': uiText('settings:text_937d13c1ea55'),
  UTC: uiText('settings:text_1dc12ee02dd2'),
}));
let knownZones: string[] | undefined;
export function validTimeZone(value: unknown) {
  try {
    normalizeTimeZone(value);
    return true;
  } catch {
    return false;
  }
}
export function displayTimeZone(timeZone?: string) {
  try {
    const zone = effectiveTimeZone(timeZone);
    return zone === DEFAULT_TIME_ZONE ? uiText('settings:beijingTime') : zone;
  } catch {
    return uiText('settings:text_af601dd2ad34');
  }
}
export function timeZoneOptions(selected = DEFAULT_TIME_ZONE) {
  if (!knownZones) {
    let supported: string[] = [];
    try {
      supported = Intl.supportedValuesOf?.('timeZone') || [];
    } catch {
      /* Common choices work on older clients. */
    }
    knownZones = [...new Set([...Object.keys(cities), ...supported])];
  }
  return [...new Set([selected, ...knownZones])].map((value) => ({
    value,
    label: cities[value] ? `${cities[value]} · ${value}` : value,
  }));
}
export function zonedTimeLabel(value: string | number, timeZone?: string) {
  const date = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(date)) return uiText('settings:text_ea6fb76bff48');
  try {
    const zone = effectiveTimeZone(timeZone);
    return `${new Intl.DateTimeFormat(currentLanguage(), {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date)} · ${displayTimeZone(zone)}`;
  } catch {
    return uiText('settings:text_3541ab9fa8f8');
  }
}
