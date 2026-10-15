/* ==========================================
   REVISEFORFUN - BACKEND CLIENT
   The app works fully offline with localStorage. When a backend is reachable
   (same origin by default, or a custom URL from the Community page) it adds
   accounts, cloud sync, sharing and the leaderboard.
   ========================================== */
const API = (() => {
    const LS_BASE = 'rff_api_base';
    const LS_TOKEN = 'rff_token';
    const LS_USER = 'rff_user';

    const state = {
        base: localStorage.getItem(LS_BASE) || '',
        token: localStorage.getItem(LS_TOKEN) || '',
        user: (() => { try { return JSON.parse(localStorage.getItem(LS_USER)); } catch { return null; } })(),
        online: false, // backend reachable?
        checked: false,
    };

    function url(path) {
        const base = state.base.replace(/\/+$/, '');
        return base ? `${base}/${path}` : path; // relative so it works under /subpath/ too
    }

    async function request(method, path, body, { timeout = 10000 } = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(url(path), {
                method,
                headers: {
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            let json = null;
            try { json = await res.json(); } catch { /* non-JSON response */ }
            if (!res.ok) {
                const err = new Error((json && json.error) || `Request failed (${res.status})`);
                err.status = res.status;
                if (res.status === 401 && state.token) setSession('', null); // expired session
                throw err;
            }
            return json;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('The server took too long to respond.');
            if (e instanceof TypeError) throw new Error('Could not reach the server.');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    function setSession(token, user) {
        state.token = token || '';
        state.user = user || null;
        if (token) localStorage.setItem(LS_TOKEN, token); else localStorage.removeItem(LS_TOKEN);
        if (user) localStorage.setItem(LS_USER, JSON.stringify(user)); else localStorage.removeItem(LS_USER);
    }

    function setBase(base) {
        state.base = (base || '').trim().replace(/\/+$/, '');
        if (state.base) localStorage.setItem(LS_BASE, state.base); else localStorage.removeItem(LS_BASE);
        setSession('', null);
    }

    async function ping() {
        try {
            const h = await request('GET', 'api/health', undefined, { timeout: 4000 });
            state.online = Boolean(h && h.ok);
        } catch {
            state.online = false;
        }
        state.checked = true;
        return state.online;
    }

    return {
        state,
        ping,
        setBase,
        isLoggedIn: () => Boolean(state.token && state.user),
        register: async (username, password) => {
            const r = await request('POST', 'api/auth/register', { username, password });
            setSession(r.token, r.user);
            return r.user;
        },
        login: async (username, password) => {
            const r = await request('POST', 'api/auth/login', { username, password });
            setSession(r.token, r.user);
            return r.user;
        },
        logout: async () => {
            try { await request('POST', 'api/auth/logout', {}); } catch { /* ignore */ }
            setSession('', null);
        },
        deleteAccount: async (password) => {
            await request('DELETE', 'api/auth/account', { password });
            setSession('', null);
        },
        setLeaderboard: async (show) => {
            const r = await request('PATCH', 'api/auth/me', { showOnLeaderboard: show });
            setSession(state.token, r.user);
            return r.user;
        },
        me: () => request('GET', 'api/auth/me'),
        sync: (data) => request('PUT', 'api/sync', { data }, { timeout: 20000 }),
        leaderboard: () => request('GET', 'api/leaderboard?limit=20'),
        createShare: (title, cards) => request('POST', 'api/share', { title, cards }),
        myShares: () => request('GET', 'api/share'),
        getShare: (code) => request('GET', `api/share/${encodeURIComponent(code)}`),
        deleteShare: (code) => request('DELETE', `api/share/${encodeURIComponent(code)}`),
        /** Preset library: static JSON first (works on GitHub Pages), API as fallback. */
        loadLibrary: async () => {
            try {
                const res = await fetch('data/library.json');
                if (res.ok) return (await res.json()).decks;
            } catch { /* fall through */ }
            const r = await request('GET', 'api/decks');
            const full = await Promise.all(r.decks.map((d) => request('GET', `api/decks/${d.id}`)));
            return full;
        },
    };
})();
