const film = document.getElementById('film');
const shots = document.querySelectorAll('.shot');

// Standalone playback keeps the film in view. Each shot also has a native, linkable preview.
if (typeof film.play === 'function') {
  for (const shot of shots) {
    shot.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      film.currentTime = Number(shot.dataset.start);
      film.play().catch(() => film.focus());
    });
  }
  function markCurrent() {
    for (const shot of shots) {
      const start = Number(shot.dataset.start);
      shot.setAttribute(
        'aria-current',
        String(film.currentTime >= start && film.currentTime < start + 5),
      );
    }
  }
  film.addEventListener('timeupdate', markCurrent);
  markCurrent();
}
