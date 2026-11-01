/** Static Tailwind build for the public pages (replaces the cdn.tailwindcss.com script there): npm run build:css */
module.exports = {
  content: [
    './public/index.html', './public/pricing.html', './public/login.html', './public/connect.html', './public/assets/connect.js', './public/privacy.html', './public/terms.html', './public/data-deletion.html',
    './public/networks.html', './public/networks/*.html', './public/developers.html', './public/integrations.html', './public/security.html',
    './public/changelog.html', './public/about.html', './public/partners.html', './public/partners/*.html',
    './public/assets/nav-auth.js', './public/assets/status.js', './public/assets/pricing.js', './public/assets/contact.js', './public/assets/auth.js', './scripts/build-site-pages.mjs', './site/*.html',
  ],
  theme: { extend: {} },
  plugins: [],
};
