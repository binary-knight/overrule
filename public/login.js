document.getElementById('pair-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const response = await fetch('/api/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('pair-code').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    document.getElementById('pair-code').value = ''; location.assign('/');
  } catch (error) { document.getElementById('pair-error').textContent = error.message; button.disabled = false; }
});
