import {
  avatarColor,
  avatarShape,
  avatarTheme,
  type AvatarShape,
  type AvatarTheme,
  type OriginalAvatarTheme,
  isOriginalAvatarTheme,
} from '../avatarThemes';
import { CommunityAvatarArtwork } from './CommunityAvatarArtwork';
import { Chick, Elephant } from './AnimalAvatarArtwork';
import { AvatarFaceEyes } from './AvatarFaceEyes';
import { avatarEyeTilt, type AvatarFaceMotion } from './avatarFaceMotion';

type ArtworkProps = { shape: AvatarShape; color: string; faceMotion?: AvatarFaceMotion };

const ink = '#292733';
const paper = '#fffdf7';
const silhouettes: Record<AvatarShape, string> = {
  orb: 'M14 15C7 17 5 27 7 39C8 52 19 58 33 57C48 57 58 49 58 35C58 23 53 16 44 13L43 6Q35 4 32 12Q22 9 17 5Q10 5 14 15Z',
  drop: 'M31 5C24 5 22 15 17 20C9 27 7 33 8 41C9 52 19 58 33 57C49 57 57 48 56 36C55 26 45 20 40 13Q35 4 31 5Z',
  leaf: 'M12 6C29 3 51 17 56 34C62 51 45 59 29 57C12 56 6 49 7 34C7 24 8 11 12 6Z',
  spark: 'M28 6Q32 1 36 7L54 33Q63 48 49 54Q35 59 17 55Q3 53 7 39L17 20L17 9Q21 6 24 12Z',
  gem: 'M18 8Q21 4 27 7L49 18Q55 21 56 28L51 46Q49 54 40 57L18 53Q9 51 7 42L8 22Q8 15 18 8Z',
  arch: 'M13 17L12 7Q18 4 24 12Q32 9 40 12Q47 4 52 8L51 19Q58 27 58 40L56 50Q54 57 45 57H19Q8 57 7 49V35Q7 23 13 17Z',
};
function Eyes({
  shape,
  theme,
  faceMotion,
}: Pick<ArtworkProps, 'shape' | 'faceMotion'> & { theme: OriginalAvatarTheme }) {
  const panda = theme === 'pandas';
  return (
    <g className="avatar-eyes" transform={avatarEyeTilt(theme, shape)}>
      {panda && (
        <g fill={ink}>
          <ellipse cx="23" cy="31" rx="8" ry="10" transform="rotate(22 23 31)" />
          <ellipse cx="43" cy="31" rx="8" ry="10" transform="rotate(-22 43 31)" />
        </g>
      )}
      {faceMotion ? (
        <AvatarFaceEyes theme={theme} shape={shape} motion={faceMotion} />
      ) : (
        <>
          <rect x="18" y="23" width="10" height="15" rx="5" fill={paper} />
          <rect x="37" y="23" width="10" height="15" rx="5" fill={paper} />
          <g fill={ink}>
            <rect x={shape === 'drop' ? 22 : 23} y="28" width="4" height="7" rx="2" />
            <rect x={shape === 'drop' ? 41 : 42} y="28" width="4" height="7" rx="2" />
          </g>
        </>
      )}
      {shape === 'arch' && (
        <path d="M17 25H29M36 25H48" stroke={panda ? ink : paper} strokeWidth="3" />
      )}
    </g>
  );
}
function Smile({ shape }: { shape: AvatarShape }) {
  return shape === 'spark' ? (
    <path d="M29 43Q34 49 39 42" fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
  ) : (
    <path d="M30 43Q34 46 38 42" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
  );
}
function Companion({ shape, color, faceMotion }: ArtworkProps) {
  return (
    <>
      <path d={silhouettes[shape]} fill={color} />
      <path d="M13 46Q31 55 52 45Q46 57 31 57Q17 57 13 46Z" fill={ink} opacity=".08" />
      <path
        d="M15 21Q17 16 23 15"
        fill="none"
        stroke={paper}
        strokeOpacity=".38"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Eyes shape={shape} theme="companions" faceMotion={faceMotion} />
      <Smile shape={shape} />
      <ellipse cx="16" cy="39" rx="3.5" ry="2" fill={paper} opacity=".23" />
      <ellipse cx="49" cy="39" rx="3.5" ry="2" fill={paper} opacity=".23" />
    </>
  );
}
function Panda({ shape, color, faceMotion }: ArtworkProps) {
  const ears: Record<AvatarShape, [number, number, number]> = {
    orb: [15, 49, 11],
    drop: [17, 47, 9],
    leaf: [12, 48, 12],
    spark: [16, 49, 10],
    gem: [14, 50, 13],
    arch: [13, 51, 10],
  };
  const [left, right, top] = ears[shape];
  return (
    <>
      <rect x="3" y="5" width="58" height="56" rx={shape === 'gem' ? 18 : 27} fill={color} />
      <circle cx={left} cy={top + 5} r="10" fill={ink} />
      <circle cx={right} cy={top + 5} r="10" fill={ink} />
      <circle cx={left} cy={top + 5} r="4" fill={color} />
      <circle cx={right} cy={top + 5} r="4" fill={color} />
      <path d="M10 30Q11 13 31 13Q52 12 55 30Q60 48 46 53Q32 59 18 53Q5 49 10 30Z" fill={paper} />
      <Eyes shape={shape} theme="pandas" faceMotion={faceMotion} />
      <path d="M29 40Q33 37 37 40Q36 44 33 44Q30 44 29 40Z" fill={ink} />
      <path
        d="M33 44V46M29 46Q33 49 37 46"
        fill="none"
        stroke={ink}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M17 52Q32 58 47 52L44 59Q31 63 20 58Z" fill={color} />
      {shape === 'leaf' && (
        <path d="M42 12Q46 1 54 6Q52 14 42 12Z" fill={color} stroke={ink} strokeWidth="1.3" />
      )}
      {shape === 'spark' && <path d="M28 12L32 5L36 12" fill={color} />}
      {shape === 'gem' && <path d="M46 52L51 57L46 62L41 57Z" fill={paper} />}
      {shape === 'drop' && <circle cx="46" cy="53" r="4" fill={paper} />}
    </>
  );
}
function Dinosaur({ shape, color, faceMotion }: ArtworkProps) {
  return (
    <>
      <path d="M13 43Q3 43 3 31Q10 37 19 31" fill={color} />
      <g fill={ink} opacity=".8">
        <path
          d={
            shape === 'arch'
              ? 'M14 20L10 8L24 14L31 3L38 14L53 8L50 24Z'
              : 'M13 25L10 15L21 15L25 5L33 13L42 5L46 17L56 17L52 29Z'
          }
        />
      </g>
      <path
        d={
          shape === 'gem'
            ? 'M17 17Q31 9 47 19L55 32L53 48Q50 57 32 58Q14 58 11 48L10 31Z'
            : 'M12 28Q13 12 32 12Q52 12 55 29L57 42Q59 57 34 58Q10 58 10 43Z'
        }
        fill={color}
      />
      {shape === 'drop' && <path d="M25 16Q23 4 32 2Q39 7 35 15" fill={color} />}
      {shape === 'leaf' && <path d="M10 33L2 25Q2 43 14 45M54 33L62 25Q63 43 52 45" fill={color} />}
      <Eyes shape={shape} theme="dinosaurs" faceMotion={faceMotion} />
      <path d="M19 39Q34 33 50 39Q56 44 50 50Q36 57 21 51Q13 46 19 39Z" fill={paper} />
      <g fill={ink}>
        <circle cx="28" cy="41" r="1.4" />
        <circle cx="44" cy="41" r="1.4" />
      </g>
      <path
        d="M28 47Q37 51 45 46"
        fill="none"
        stroke={ink}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {shape === 'spark' && (
        <path d="M33 49L36 54L39 49" fill={paper} stroke={ink} strokeWidth=".8" />
      )}
      <g fill={ink} opacity=".17">
        <circle cx="16" cy="29" r="2" />
        <circle cx="51" cy="28" r="1.5" />
      </g>
    </>
  );
}

type AvatarArtworkProps = {
  theme?: AvatarTheme;
  shape?: string;
  color?: string;
  size?: number;
  faceMotion?: AvatarFaceMotion;
};

/** The same original artwork renders in the product, chooser and exported assets. */
export function AvatarArtwork(props: AvatarArtworkProps) {
  return renderArtwork({ ...props, color: avatarColor(props.color, props.shape) });
}

/** Offline source export retains the fills used by Flutter's vector color mapper. */
export function AvatarSourceArtwork(props: AvatarArtworkProps) {
  const color =
    typeof props.color === 'string' && /^#[a-f\d]{6}$/i.test(props.color)
      ? props.color
      : avatarColor(undefined, props.shape);
  return renderArtwork({ ...props, color });
}

function renderArtwork({
  theme = 'companions',
  shape = 'orb',
  color,
  size = 38,
  faceMotion,
}: AvatarArtworkProps & { color: string }) {
  const selected = avatarTheme(theme),
    form = avatarShape(shape),
    fill = color;
  if (!isOriginalAvatarTheme(selected))
    return (
      <CommunityAvatarArtwork
        theme={selected}
        shape={form}
        color={fill}
        size={size}
        motion={faceMotion}
      />
    );
  const Artwork = {
    companions: Companion,
    pandas: Panda,
    dinosaurs: Dinosaur,
    chicks: Chick,
    elephants: Elephant,
  }[selected];
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      data-avatar-theme={selected}
      data-avatar-shape={form}
      aria-hidden="true"
      focusable="false"
    >
      <Artwork shape={form} color={fill} faceMotion={faceMotion} />
    </svg>
  );
}
