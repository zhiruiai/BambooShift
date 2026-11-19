(() => {
  const el = id => document.getElementById(id);
  const format = amount => '¥' + amount.toLocaleString('en-US');
  const packs = [6, 8, 12];
  let delayed = true;
  let budget = 5500;
  function render() {
    const index = (delayed ? 2 : 0) + Number(budget === 6900);
    const plan = window.rainPlans[index];
    const cost = [delayed ? 345 : 280, 98, 42];
    el('signal').textContent = delayed ? '● 到货变更' : '● 原订交期';
    el('brief').textContent = delayed ? '常规雨壳 96 小时才到。同城只剩 1 箱，每件加 ¥65。' : '常规雨壳 24 小时到货，三款商品都能赶上开店。';
    el('eta').textContent = delayed ? '同城 12h' : '常规 24h';
    el('gain').textContent = format(plan.margin);
    el('spend').textContent = format(plan.spend);
    el('gap').textContent = plan.unfilled + ' 件';
    el('po').textContent = 'PO–R' + (delayed ? 2 : 1) + ' / ' + budget;
    plan.cartons.forEach((count, i) => {
      const units = count * packs[i];
      el('qty' + i).textContent = count + ' 箱 · ' + units + ' 件';
      el('amt' + i).textContent = format(units * cost[i]);
    });
    for (let i = 0; i < 4; i++) el('po' + i).classList.toggle('hide', i !== index);
    for (const [key, active] of [['normal', !delayed], ['disrupted', delayed], ['low', budget === 5500], ['high', budget === 6900]]) {
      const button = el(key);
      button.classList.toggle('active', active);
      if (button.setAttribute) button.setAttribute('aria-pressed', String(active));
    }
  }
  el('normal').onclick = () => { delayed = false; budget = 6900; render(); };
  el('disrupted').onclick = () => { delayed = true; budget = 5500; render(); };
  el('low').onclick = () => { budget = 5500; render(); };
  el('high').onclick = () => { budget = 6900; render(); };
  render();
})();
