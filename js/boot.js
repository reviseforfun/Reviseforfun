/* ==========================================
   REVISEFORFUN - BOOT
   ========================================== */
(function boot() {
    loadData();
    applyTheme(appData.theme || 'light');
    updateChrome();
    renderPage(pageFromHash());

    window.addEventListener('scroll', () => {
        $('navbar').classList.toggle('scrolled', window.scrollY > 10);
    }, { passive: true });

    // Loading screen – never block the app if something is slow
    const hideLoader = () => $('loading-screen').classList.add('hidden');
    if (document.readyState === 'complete') setTimeout(hideLoader, 400);
    else window.addEventListener('load', () => setTimeout(hideLoader, 400));
    setTimeout(hideLoader, 2500);

    // Look for the (optional) backend and sync if we're signed in
    API.ping().then(async (online) => {
        if (online && API.isLoggedIn()) {
            try { await API.me(); } catch { /* session expired – api.js clears it */ }
            if (API.isLoggedIn()) await Sync.now({ quiet: true });
        }
        if (currentPage === 'community') renderers.community();
    });

    // Offline support (needs https or localhost)
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
    }
})();
