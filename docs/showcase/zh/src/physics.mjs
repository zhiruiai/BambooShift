
export const initial = { height: 1200, speed: 72, drift: 14 };
export function flight(state, control) {
  if (control === 'align') return { ...state, drift: 0 };
  if (control === 'brake') return { ...state, speed: 12, height: 380 };
  if (state.speed <= 12 && state.drift === 0) return { height: 0, speed: 0, drift: 0 };
  return state;
}
