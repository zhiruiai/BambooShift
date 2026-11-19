const byId = (id) => document.getElementById(id);
const pages = document.querySelectorAll('.sheet');
let slide = 0;

function show(index) {
  slide = Math.max(0, Math.min(index, pages.length - 1));
  pages.forEach((page, i) => page.classList.toggle('on', i === slide));
  byId('count').textContent = String(slide + 1).padStart(2, '0') + ' / 05';
  for (const [id, disabled] of [
    ['prev', slide === 0],
    ['next', slide === pages.length - 1],
  ]) {
    const button = byId(id);
    button.disabled = disabled;
    button.classList.toggle('unavailable', disabled);
  }
}
byId('prev').onclick = () => show(slide - 1);
byId('next').onclick = () => show(slide + 1);
document.addEventListener('keydown', (event) => {
  if (event.target?.matches?.('input,button,a') || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowRight') show(slide + 1);
  if (event.key === 'ArrowLeft') show(slide - 1);
});

const slider = byId('occupancy');
function calculateSurplus() {
  const sold = Number(slider.value);
  const surplus = sold * 37 - 13800;
  byId('occ').textContent = sold + ' / 600';
  byId('sim').textContent = (surplus < 0 ? '−¥' : '¥') + Math.abs(surplus).toLocaleString('zh-CN');
  byId('sim').style.color = surplus < 0 ? '#a63423' : '#385336';
}
slider.addEventListener('input', calculateSurplus);

const opinions = {
  同意试点: '建议批准单馆分段试点，按四周检查条件执行。',
  退回重算: '请财务复算到场率和固定支出后，再提交董事会。',
  暂缓表决: '本次只记录已审材料，预算暂不授权。',
};
const votes = document.querySelectorAll('.vote');
const downloads = document.querySelectorAll('.decision-download');
for (const button of votes) {
  button.onclick = () => {
    const selection = button.dataset.vote;
    for (const vote of votes) {
      vote.classList.toggle('selected', vote.dataset.vote === selection);
      vote.setAttribute?.('aria-pressed', String(vote.dataset.vote === selection));
    }
    for (const link of downloads)
      link.classList.toggle('concealed', link.dataset.vote !== selection);
    byId('voteResult').textContent = '意见草案 · ' + opinions[selection];
  };
}
if (typeof window.print === 'function') {
  byId('print').classList.remove('concealed');
  byId('print').onclick = () => window.print();
}
show(0);
