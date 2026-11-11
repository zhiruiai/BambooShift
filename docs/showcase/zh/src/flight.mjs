
import { flight, initial } from './physics.mjs';
let state = { ...initial };
const find = (id) => document.getElementById(id);
const scene = document.querySelector('.scene');
const status = find('status');
function render() {
  find('height').textContent = state.height.toLocaleString('en') + ' m';
  find('speed').textContent = state.speed + ' m/s';
  find('drift').textContent = state.drift + '°';
  scene.classList.toggle('aligned', state.drift === 0);
  scene.classList.toggle('braking', state.speed === 12);
  scene.classList.toggle('landed', state.height === 0);
}
for (const id of ['align', 'brake', 'land']) {
  find(id).addEventListener('click', () => {
    if (state.height === 0) return;
    state = flight(state, id);
    if (id === 'land') {
      status.textContent = state.height === 0 ? "✓ 软着陆完成" : "请先校准航向并启动反推";
      if (state.height === 0) status.classList.add('success');
    } else {
      status.textContent = id === 'align' ? "航向已对准着陆坪" : "下降速度已减至 12 m/s";
      find(id).classList.add('selected');
    }
    render();
  });
}
status.textContent = "等待飞行指令";
