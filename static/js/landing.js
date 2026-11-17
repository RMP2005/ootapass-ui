/* Scroll is a camera, not a navigation lock: native anchors and operations stay usable. */
(() => {
  'use strict';
  const flight = document.querySelector('.lp-flight');
  const stage = document.querySelector('.lp-stage');
  if (!flight || !stage) return;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const chapters = [
    ['Start with who’s waiting.', 'A gate request carries a meal count, food preference and deadline. No family names or IDs.'],
    ['Connect what can reach.', 'Food, runner capacity, gate deadlines and donor use-by times must all line up.'],
    ['Keep the reason in view.', 'A cancellation protects picked-up trips, re-plans the rest and explains each uncovered meal.'],
  ];
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  let frame = 0;
  let previousChapter = -1;
  function render() {
    frame = 0;
    if (preference.matches) {
      stage.removeAttribute('style');
      document.querySelector('.lp-journey-link').href = '#project';
      document.querySelector('.lp-hero-copy').inert = false;
      document.querySelector('.lp-story-caption').inert = true;
      return;
    }
    document.querySelector('.lp-journey-link').href = '#story-start';
    const rect = flight.getBoundingClientRect();
    const progress = clamp(-rect.top / Math.max(1, flight.offsetHeight - innerHeight));
    const mobile = innerWidth < 700;
    const hero = 1 - clamp(progress / .17);
    const approach = clamp((progress - .12) / .5);
    const zoom = clamp((progress - .72) / .28);
    const caption = clamp((progress - .12) / .08) * (1 - clamp((progress - .88) / .12));
    const coreLift = approach * (mobile ? -520 : -650);
    stage.style.setProperty('--hero-opacity', hero.toFixed(3));
    stage.style.setProperty('--hero-events', hero > .5 ? 'auto' : 'none');
    stage.style.setProperty('--caption-opacity', caption.toFixed(3));
    stage.style.setProperty('--caption-events', caption > .5 ? 'auto' : 'none');
    stage.style.setProperty('--caption-y', `${(1 - caption) * 24}px`);
    stage.style.setProperty('--core-y', `${coreLift}px`);
    stage.style.setProperty('--core-z', `${zoom * (mobile ? 430 : 650)}px`);
    stage.style.setProperty('--core-rx', `${20 * (1 - approach)}deg`);
    stage.style.setProperty('--core-ry', `${-12 * (1 - approach)}deg`);
    stage.style.setProperty('--core-rz', `${-7 * (1 - approach)}deg`);
    stage.style.setProperty('--satellite-opacity', (1 - clamp((progress - .08) / .16)).toFixed(3));
    stage.style.setProperty('--spread-left', `${-progress * 400}px`);
    stage.style.setProperty('--spread-right', `${progress * 400}px`);
    document.querySelector('.lp-hero-copy').inert = hero < .5;
    document.querySelector('.lp-story-caption').inert = caption < .5;
    stage.classList.toggle('is-scrolling', progress > .15);
    const chapter = progress < .38 ? 0 : progress < .65 ? 1 : 2;
    if (chapter !== previousChapter) {
      document.getElementById('lp-chapter-number').textContent = `0${chapter + 1} / 03`;
      document.getElementById('lp-chapter-title').textContent = chapters[chapter][0];
      document.getElementById('lp-chapter-description').textContent = chapters[chapter][1];
      stage.dataset.chapter = chapter;
      stage.querySelectorAll('.lp-chapter-dots a').forEach((a, i) => a.classList.toggle('is-active', i === chapter));
      previousChapter = chapter;
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  preference.addEventListener('change', schedule);
  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement.dataset.surface !== 'workspace') return;
    const query = new URLSearchParams(location.search);
    const view = query.get('view');
    if (['gates', 'trips', 'supply', 'activity'].includes(view)) document.getElementById(`t-${view}`)?.click();
    if (query.get('evidence') === '1') document.getElementById('evidence')?.showModal();
    document.title = 'OotaPass · Dispatch workspace';
  });
  render();
})();
