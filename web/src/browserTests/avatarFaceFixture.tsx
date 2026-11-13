import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar } from '../components/Avatar';
import { AvatarArtwork } from '../components/AvatarArtwork';
import type { AvatarFaceState } from '../components/avatarFaceMotion';
import { AVATAR_SHAPES, AVATAR_THEMES, type AvatarTheme } from '../avatarThemes';
import '../styles-sections/01-base.css';
import './avatarFaceFixture.css';

const themes = {
  companions: { label: 'Companions', color: '#8651d8' },
  pandas: { label: 'Pandas', color: '#7051ca' },
  dinosaurs: { label: 'Dinosaurs', color: '#169771' },
  chicks: { label: 'Chicks', color: '#dda02e' },
  elephants: { label: 'Elephants', color: '#5085c8' },
} satisfies Record<AvatarTheme, { label: string; color: string }>;

const states = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  attention: 'Needs approval',
  done: 'Completed',
  error: 'Failed',
} satisfies Record<AvatarFaceState, string>;

const mount = document.getElementById('fixture')!;
const previewOnly = mount.dataset.preview === 'true';

function Fixture() {
  const [state, setState] = useState<AvatarFaceState>('idle');
  const [stress, setStress] = useState(false);
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const motion = { state, sustain: true };
  return (
    <main className="face-fixture" data-scene={state}>
      <header>
        <span className="fixture-brand">BambooShift</span>
        <h1>Every Bot has a face</h1>
        <p>
          <span className="fixture-state" aria-live="polite">
            {states[state]}
          </span>
          <span>Task expressions across five avatar themes</span>
        </p>
      </header>
      <div className="fixture-grid" id="faces">
        {AVATAR_THEMES.map((theme) => (
          <article key={theme} data-face-sample={theme}>
            <h2>{themes[theme].label}</h2>
            <div className="fixture-hero">
              <AvatarArtwork
                theme={theme}
                color={themes[theme].color}
                size={132}
                faceMotion={motion}
              />
            </div>
            <div className="fixture-sizes">
              <AvatarArtwork
                theme={theme}
                color={themes[theme].color}
                size={24}
                faceMotion={motion}
              />
              <AvatarArtwork
                theme={theme}
                color={themes[theme].color}
                size={32}
                faceMotion={motion}
              />
              <span>24 / 32 px</span>
            </div>
          </article>
        ))}
      </div>
      <div role="group" aria-label="Task state" className="fixture-controls">
        {Object.entries(states).map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              setAwaitingCompletion(false);
              setState(value as AvatarFaceState);
            }}
            aria-pressed={state === value}
          >
            {label}
          </button>
        ))}
      </div>
      {!previewOnly && (
        <section className="fixture-test-extras">
          <button onClick={() => setStress(!stress)}>
            {stress ? 'Remove test avatars' : 'Add test avatars'}
          </button>
          <div id="uploaded">
            <Avatar
              agent={{ avatarImageId: '11111111-1111-4111-8111-111111111111' }}
              motion={state}
              sustain
            />
          </div>
          <button onClick={() => setAwaitingCompletion(true)}>Wait for result</button>
          <div id="live-avatar">
            <Avatar
              motion={awaitingCompletion ? undefined : state}
              awaitingCompletion={awaitingCompletion}
            />
          </div>
          <div id="historical">
            <Avatar motion="done" />
          </div>
          <div id="historical-error">
            <Avatar motion="error" />
          </div>
          <div id="stress">
            {stress &&
              Array.from({ length: 10 }, (_, index) =>
                AVATAR_THEMES.map((theme, i) => (
                  <AvatarArtwork
                    key={`${theme}-${index}`}
                    theme={theme}
                    shape={AVATAR_SHAPES[(i + index) % AVATAR_SHAPES.length]}
                    size={24}
                    faceMotion={motion}
                  />
                )),
              )}
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(mount).render(<Fixture />);
