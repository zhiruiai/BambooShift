import type { AvatarShape } from '../avatarThemes';

type ArtworkProps = { shape: AvatarShape; color: string };

const ink = '#292733';
const paper = '#fffdf7';
const feather = '#ffe6a6';
const beak = '#ee8f45';

const chickCrests: Record<AvatarShape, string> = {
  orb: 'M25 14Q21 9 24 7Q28 5 33 11Q33 4 38 5Q43 6 39 15Z',
  drop: 'M27 15Q23 8 28 4Q35 6 37 14Z',
  leaf: 'M24 15Q20 7 25 6Q30 5 33 13Q37 3 44 7Q45 12 39 15Z',
  spark: 'M24 16L23 7L30 11L34 3L39 11L44 7L43 16Z',
  gem: 'M23 15L26 6L33 4L41 9L42 16Z',
  arch: 'M21 15Q20 7 25 7Q29 7 32 12Q38 4 43 8Q47 12 43 17Z',
};

export function Chick({ shape, color }: ArtworkProps) {
  return (
    <>
      <path d="M22 52L18 59H27L31 54M34 54L37 59H46L42 52" fill={beak} />
      <path d={chickCrests[shape]} fill={color} />
      <path
        d="M32 11C48 11 56 22 56 37C56 51 45 57 32 57C18 57 8 50 8 37C8 22 16 11 32 11Z"
        fill={color}
      />
      <path
        d="M32 15C45 15 52 25 52 36C52 47 44 52 32 52C20 52 12 47 12 36C12 25 19 15 32 15Z"
        fill={feather}
      />
      <path
        d="M20 24Q22 20 27 20"
        fill="none"
        stroke={paper}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <g className="avatar-eyes" fill={ink}>
        <rect x="21" y="28" width="5" height="8" rx="2.5" />
        <rect x="38" y="28" width="5" height="8" rx="2.5" />
      </g>
      <g fill="#eea37f">
        <ellipse cx="18" cy="38" rx="3.5" ry="1.7" />
        <ellipse cx="46" cy="38" rx="3.5" ry="1.7" />
      </g>
      <path d="M26 37Q32 33 38 37Q34 44 32 44Q30 44 26 37Z" fill={beak} />
      <path d="M28 38L36 38" stroke="#ba5b34" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 39Q16 46 21 46Q18 51 13 47Z M53 39Q48 46 43 46Q46 51 51 47Z" fill={color} />
    </>
  );
}

const elephantEars: Record<AvatarShape, string> = {
  orb: 'M21 19C11 9 3 19 4 31C4 43 11 49 21 43M43 19C53 9 61 19 60 31C60 43 53 49 43 43',
  drop: 'M20 18Q4 11 4 29Q5 45 21 46M44 18Q60 11 60 29Q59 45 43 46',
  leaf: 'M21 19Q7 10 4 17Q3 39 20 46M43 19Q57 10 60 17Q61 39 44 46',
  spark: 'M21 19Q6 10 4 22Q0 36 13 45L22 43M43 19Q58 10 60 22Q64 36 51 45L42 43',
  gem: 'M22 18L10 13L3 24L5 39L15 46L23 42M42 18L54 13L61 24L59 39L49 46L41 42',
  arch: 'M21 19Q9 11 5 18Q0 30 6 40Q12 47 22 42M43 19Q55 11 59 18Q64 30 58 40Q52 47 42 42',
};

export function Elephant({ shape, color }: ArtworkProps) {
  return (
    <>
      <path d={elephantEars[shape]} fill={color} />
      <path
        d="M17 23Q8 18 8 29Q8 38 17 40M47 23Q56 18 56 29Q56 38 47 40"
        fill={paper}
        opacity=".62"
      />
      <path
        d="M32 8Q50 8 50 27V34Q50 46 38 48Q37 53 43 53Q47 53 48 49Q49 46 52 47Q55 49 53 53Q51 59 44 60Q32 61 28 50Q14 48 14 34V27Q14 8 32 8Z"
        fill={color}
      />
      <path
        d="M20 24Q21 15 31 14"
        fill="none"
        stroke={paper}
        strokeOpacity=".58"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <g className="avatar-eyes" fill={paper}>
        <rect x="20" y="25" width="10" height="13" rx="5" />
        <rect x="34" y="25" width="10" height="13" rx="5" />
        <rect x="24" y="29" width="4" height="6" rx="2" fill={ink} />
        <rect x="37" y="29" width="4" height="6" rx="2" fill={ink} />
      </g>
      <path
        d="M24 41Q27 45 29 44M39 43Q42 44 45 40"
        fill="none"
        stroke={ink}
        opacity=".55"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M32 46L36 46M34 50L38 49"
        fill="none"
        stroke={ink}
        opacity=".32"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M15 39Q17 47 23 46L22 42Z M48 39Q45 46 41 46L42 42Z" fill={paper} />
    </>
  );
}
