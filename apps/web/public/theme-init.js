// Apply the stored theme before first paint (per-device convenience; the server keeps the preference).
try { var t = localStorage.getItem('sb-theme'); if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.dataset.theme = 'dark'; } catch (e) {}
