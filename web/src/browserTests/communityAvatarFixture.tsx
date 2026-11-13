import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar } from '../components/Avatar';
import { AvatarArtwork } from '../components/AvatarArtwork';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { COMMUNITY_AVATAR_PACKS, type CommunityAvatarTheme } from '../avatarThemes';
import { initializeLanguage } from '../i18n';
import type { AvatarFaceState } from '../components/avatarFaceMotion';
import { AVATAR_COLORS, AVATAR_ROLE_COLORS } from '../../../shared/avatar-palette';
import '../styles-sections/01-base.css';
import '../theme.css';
import './communityAvatarFixture.css';

const controller = initializeLanguage();
controller.setLanguage('en');
function Fixture() {
  const [state, setState] = useState<AvatarFaceState>('idle');
  const [show, setShow] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [english, setEnglish] = useState(true);
  return (
    <main className="community-fixture">
      <header>
        <span>BambooShift · Community collections</span>
        <h1>A little personality. A whole team.</h1>
        <p>40 community avatars. Native expressions. One shared workspace.</p>
      </header>
      <div className="community-layout">
        <aside>
          <AppearanceSettings />
        </aside>
        <section className="community-gallery">
          <div className="community-controls" role="group" aria-label="Task state">
            {(['idle', 'thinking', 'working', 'attention', 'done', 'error'] as const).map(
              (value) => (
                <button
                  key={value}
                  aria-pressed={state === value}
                  onClick={() => {
                    setWaiting(false);
                    setState(value);
                  }}
                >
                  {value}
                </button>
              ),
            )}
          </div>
          <div id="selected-avatar">
            <Avatar
              agent={{ avatar: 'orb', color: AVATAR_ROLE_COLORS.orb }}
              size={90}
              sustain
              motion={waiting ? undefined : state}
              awaitingCompletion={waiting}
            />
          </div>
          <p className="community-caption">
            {state === 'working'
              ? 'Your team is bringing the idea to life'
              : state === 'done'
                ? 'Ready to share something wonderful'
                : 'Choose a character, give it a task'}
          </p>
          {show &&
            COMMUNITY_AVATAR_PACKS.map((pack) => (
              <section className="community-pack" data-pack={pack.id} key={pack.id}>
                <h2>
                  {pack.name}
                  <span>{pack.themes.length} characters</span>
                </h2>
                <div className="community-pack-grid">
                  {pack.themes.map((theme, index) => (
                    <div key={theme.id} data-community-sample={theme.id}>
                      <AvatarArtwork
                        theme={theme.id as CommunityAvatarTheme}
                        color={AVATAR_COLORS[index % AVATAR_COLORS.length]}
                        size={62}
                        faceMotion={{ state, sustain: true }}
                      />
                      <span>{english ? theme.label.en : theme.label.zh}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          <div className="community-test-controls">
            <button onClick={() => setShow(!show)}>Toggle gallery</button>
            <button onClick={() => setWaiting(true)}>Wait for result</button>
            <button
              onClick={() => {
                controller.setLanguage(english ? 'zh-CN' : 'en');
                setEnglish(!english);
              }}
            >
              Language
            </button>
          </div>
          <div id="historical">
            <Avatar size={32} motion="done" />
          </div>
          <div style={{ height: 950 }} />
          <div id="page-end">End</div>
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById('fixture')!).render(<Fixture />);
