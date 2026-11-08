// This script is application-owned. Artifact handlers are never inserted or evaluated.
export const HTML_PREVIEW_RUNTIME = String.raw`
(() => {
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const args = (node) => JSON.parse(node.getAttribute('data-ob-args') || '[]');
  const actions = (kind, root) => all('[data-ob-action="' + kind + '"]', root);
  const panels = all('[data-ob-panel]');
  const status = document.querySelector('[data-ob-status]');
  const zh = document.documentElement.lang === 'zh';
  const announce = (english, chinese) => { if (status) status.textContent = zh ? chinese : english; };
  let stage = 0;
  let narrated = false;
  const select = (id) => {
    if (!panels.some((panel) => panel.id === id)) return;
    for (const panel of panels) {
      const active = panel.id === id;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    }
    for (const button of actions('section')) {
      const active = args(button)[0] === id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };
  const questions = all('[data-ob-answer]');
  const progress = () => {
    const element = document.getElementById('progress');
    if (element) element.textContent = (zh ? '进度：' : 'Progress: ') +
      questions.filter((q) => q.classList.contains('answered')).length + ' / ' + questions.length;
  };
  const answer = (node, key) => {
    const question = node.closest('[data-ob-answer]');
    if (!question || question.classList.contains('answered')) return;
    const choices = actions('answer', question);
    const correct = choices.filter((item) => args(item)[0] === question.getAttribute('data-ob-answer'));
    if (correct.length !== 1) return;
    question.classList.add('answered');
    for (const choice of choices) choice.setAttribute('aria-disabled', 'true');
    correct[0].classList.add('correct');
    const result = correct[0] === node;
    if (!result) node.classList.add('wrong');
    node.setAttribute('aria-pressed', 'true');
    announce(result ? 'Correct' : 'See the highlighted answer', result ? '回答正确' : '请查看高亮的正确答案');
    progress();
  };
  const resetQuiz = () => {
    for (const question of questions) {
      question.classList.remove('answered');
      for (const choice of actions('answer', question)) {
        choice.classList.remove('correct', 'wrong');
        choice.removeAttribute('aria-disabled');
        choice.removeAttribute('aria-pressed');
      }
    }
    progress();
    announce('Quiz reset', '已重置练习');
  };
  const showStage = (reset) => {
    const diagram = document.getElementById('division-anim');
    if (!diagram) return;
    const stages = all('g[id]', diagram).filter((node) => /^step[1-9][0-9]?$/.test(node.id)).slice(0, 16);
    if (!stages.length) return;
    stage = reset ? 0 : (stage + 1) % stages.length;
    stages.forEach((node, i) => { node.style.display = i === stage ? 'inline' : 'none'; });
    announce('Stage ' + (stage + 1) + ' of ' + stages.length, '第 ' + (stage + 1) + ' 步，共 ' + stages.length + ' 步');
  };
  const speak = (text) => {
    try {
      const engine = window.speechSynthesis;
      const voice = engine && engine.getVoices().find((entry) => entry.localService === true &&
        entry.lang.toLowerCase().startsWith(/[\u3400-\u9fff]/.test(text) ? 'zh' : 'en'));
      if (!voice) return announce('No matching local voice is available', '没有可用的本地声线');
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      engine.cancel();
      engine.speak(utterance);
      narrated = true;
    } catch (_) {
      announce('Local narration is unavailable', '本地朗读不可用');
    }
  };
  const activate = (node) => {
    const [first, second] = args(node);
    switch (node.getAttribute('data-ob-action')) {
      case 'section': select(first); break;
      case 'card': {
        const open = node.classList.toggle('expanded');
        node.setAttribute('aria-expanded', String(open));
        for (const detail of all('.card-detail', node)) detail.hidden = !open;
        break;
      }
      case 'speak': speak(first); break;
      case 'info': {
        const box = document.getElementById('info-box') || status;
        if (!box) break;
        const title = document.createElement('strong');
        const description = document.createElement('p');
        title.textContent = first;
        description.textContent = second;
        box.replaceChildren(title, description);
        box.hidden = false;
        box.style.setProperty('display', 'block');
        box.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'advance': showStage(false); break;
      case 'resetStages': showStage(true); break;
      case 'answer': answer(node, first); break;
      case 'resetQuiz': resetQuiz(); break;
    }
  };
  if (panels.length) select((panels.find((panel) => panel.classList.contains('active')) || panels[0]).id);
  progress();
  document.addEventListener('click', (event) => {
    const node = event.target instanceof Element && event.target.closest('[data-ob-action]');
    if (node) activate(node);
  });
  document.addEventListener('keydown', (event) => {
    const node = event.target instanceof Element && event.target.closest('[data-ob-action]');
    if (!node || node.localName === 'button' || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    activate(node);
  });
  window.addEventListener('pagehide', () => { if (narrated) window.speechSynthesis?.cancel(); });
})();
`;
