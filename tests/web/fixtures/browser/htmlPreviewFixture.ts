export function interactiveHtmlFixture(external: string) {
  return `<!doctype html>
<html>
<head>
  <title>SYNTHETIC_TITLE_ONLY</title>
  <base href="${external}">
  <link rel="stylesheet" href="${external}">
  <meta http-equiv="refresh" content="0;url=${external}">
  <style>
    @import url('${external}');
    .synthetic-hero{background:linear-gradient(120deg,#f2edf8,#f4e8dd);padding:12px}
    .synthetic-panel,.card-detail{display:none}
    .synthetic-panel.active,.synthetic-card.expanded .card-detail{display:block}
    .correct{background:#daf0df}
    .wrong{background:#f9dedf}
    #info-box{display:none}
    svg{width:220px}
  </style>
</head>
<body onload="window.__previewAttack=1">
  <h1 class="synthetic-hero">Interactive learning fixture</h1>
  <nav>
    <button class="active" onclick="showSection('lesson')">Lesson</button>
    <button onclick="showSection('diagram')">Diagram</button>
    <button onclick="showSection('practice')">Practice</button>
    <button onclick="showSection('practice');window.__previewAttack=2">Unsafe compound</button>
    <button data-ob-action="section" data-ob-args='["practice"]'>Forged action</button>
  </nav>
  <div id="lesson" class="synthetic-panel active">
    <div class="synthetic-card" onclick="toggleCard(this)">
      <h2>Cell card</h2>
      <div class="card-detail">Synthetic card details</div>
    </div>
  </div>
  <div id="diagram" class="synthetic-panel">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 100">
      <rect x="1" y="1" width="218" height="98" fill="#eedff3"/>
      <circle cx="45" cy="44" r="26" fill="#af8bb8"
        onclick="showInfo('Cell diagram','&lt;img src=${external}&gt;')"/>
      <a href="${external}"><text x="1" y="10">Unsafe SVG link</text></a>
      <image href="${external}"/>
      <use href="${external}#shape"/>
      <foreignObject width="100" height="60"><iframe src="${external}"></iframe></foreignObject>
    </svg>
    <div id="info-box"></div>
    <svg id="division-anim" viewBox="0 0 220 80">
      <g id="step1"><text x="10" y="30" font-size="8">Initial stage</text></g>
      <g id="step2" style="display:none"><text x="10" y="30">Second stage</text></g>
      <g id="step3" style="display:none"><text x="10" y="30">Third stage</text></g>
    </svg>
    <button onclick="playDivisionAnim()">Next stage</button>
    <button onclick="resetDivisionAnim()">Reset stages</button>
  </div>
  <div id="practice" class="synthetic-panel">
    <p id="progress"></p>
    <div class="question" data-ans="甲">
      <h2>Choose a synthetic answer</h2>
      <button onclick="checkAns(this,'甲')">甲</button>
      <button onclick="checkAns(this,'乙')">乙</button>
    </div>
    <button onclick="resetQuiz()">Reset quiz</button>
  </div>
  <script>window.__previewAttack=3;fetch('${external}')</script>
  <iframe src="${external}"></iframe>
  <a href="${external}" target="_blank">Unsafe link</a>
  <form action="${external}"><input autofocus><button>Unsafe form</button></form>
</body>
</html>`;
}
