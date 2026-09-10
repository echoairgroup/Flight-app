(() => {
  const path = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const active = path === '' ? 'index.html' : path;

  const links = [
    ['index.html', 'Home'],
    ['weather.html', 'Weather'],
    ['charts.html', 'Charts'],
    ['checklists.html', 'Checklists'],
    ['simbrief.html', 'SimBrief'],
    ['planner.html', 'Planner']
  ];

  document.querySelectorAll('body > header, body > nav, body > .top, body > .topbar, body > .navbar').forEach(el => {
    if (el.id !== 'flight-app-global-header') el.classList.add('fa-header-hidden');
  });

  const existing = document.getElementById('flight-app-global-header');
  if (existing) existing.remove();

  const header = document.createElement('nav');
  header.id = 'flight-app-global-header';
  header.innerHTML = `
    <div class="fa-header-inner">
      <a href="index.html" class="fa-header-brand" aria-label="Flight App Home">
        <span class="fa-header-icon"><i class="fa-solid fa-plane"></i></span>
        <span>Flight App</span>
      </a>
      <div class="fa-header-links">
        ${links.map(([href, label]) => `<a href="${href}" class="fa-header-link${active === href ? ' active' : ''}">${label}</a>`).join('')}
      </div>
      <a href="login.html" class="fa-header-profile" aria-label="Account" title="Account">
        <i class="fa-solid fa-user"></i>
      </a>
    </div>
  `;

  document.body.insertBefore(header, document.body.firstChild);
})();