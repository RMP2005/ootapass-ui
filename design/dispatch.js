/* Keyboard equivalent for existing scripted donor-row click actions. */
document.addEventListener('keydown', (event) => {
  const donor = event.target.closest?.('.demo-donor');
  if (donor && event.target === donor && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    donor.click();
  }
});
