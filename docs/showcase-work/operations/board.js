'use strict';

const events = document.querySelectorAll('.event');
const filters = document.querySelectorAll('.filter');
const lanes = document.querySelectorAll('.lane');
const text = (id, value) => {
  document.getElementById(id).textContent = value;
};
let selected = 'A';

function selectSession(id) {
  selected = id;
  const button = id ? document.getElementById('session-' + id) : null;
  for (const candidate of events) {
    candidate.classList.toggle('current', candidate.dataset.session === id);
  }
  if (!button) {
    text('detail-label', '场地核对');
    text('detail-title', '该场地没有安排活动。');
    text('detail-when', '');
    text('detail-note', '');
    return;
  }
  const data = button.dataset;
  text('detail-label', 'SESSION ' + id + '  /  场次核对');
  text('detail-title', data.title);
  text('detail-when', data.when);
  text('detail-note', data.version === 'revised' ? window.emergencyPlan[id].note : data.reason);
}

for (const button of events) {
  button.addEventListener('click', () => selectSession(button.dataset.session));
}
for (const filter of filters) {
  filter.addEventListener('click', () => {
    const room = filter.dataset.venue;
    for (const entry of filters) entry.classList.toggle('active', entry.dataset.venue === room);
    for (const lane of lanes)
      lane.classList.toggle('filtered', room !== 'all' && room !== lane.dataset.room);
    const visible = Array.from(events).filter(
      (item) => room === 'all' || item.dataset.room === room,
    );
    selectSession(
      visible.some((item) => item.dataset.session === selected)
        ? selected
        : visible[0]?.dataset.session,
    );
  });
}
