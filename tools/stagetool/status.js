// The status line, in its own module so every panel can write to it without
// importing ui.js (which imports them). The element id stays `status`.
export const setStatus = msg => {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
};
