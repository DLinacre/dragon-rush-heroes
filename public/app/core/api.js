/**
 * API client.
 *
 * Wraps `fetch` with the conventions the server expects:
 *   - credentials are always sent (session cookie),
 *   - the CSRF token is read from its readable cookie and echoed in a header
 *     on every unsafe method,
 *   - the `{ data }` / `{ error }` envelope is unwrapped,
 *   - failures become typed `ApiError`s that UI code can switch on.
 */

/** Error carrying the server's machine-readable code and details. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Read a cookie value by name. */
function cookie(name) {
  const match = document.cookie.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Perform an API request.
 * @param {string} path   e.g. '/api/player'
 * @param {object} options `{ method, body, signal }`
 */
async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (UNSAFE.has(method)) {
    const token = cookie('drh_csrf');
    if (token) headers['X-CSRF-Token'] = token;
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }

  if (response.status === 204) return null;

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { /* non-JSON body */ }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? `Request failed (${response.status})`,
      error.details
    );
  }

  return payload?.data ?? null;
}

export const api = {
  // system
  health: () => request('/api/health'),
  catalogue: () => request('/api/catalogue'),
  fairness: () => request('/api/fairness'),

  // auth
  register: (body) => request('/api/auth/register', { method: 'POST', body }),
  login: (body) => request('/api/auth/login', { method: 'POST', body }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  session: () => request('/api/auth/session'),
  changePassword: (body) => request('/api/auth/password', { method: 'POST', body }),

  // player
  player: () => request('/api/player'),
  updateProfile: (body) => request('/api/player/profile', { method: 'PATCH', body }),
  updateSettings: (body) => request('/api/player/settings', { method: 'PATCH', body }),
  exportData: () => request('/api/player/export'),
  deleteAccount: () => request('/api/player', { method: 'DELETE' }),
  ledger: (limit = 50) => request(`/api/player/ledger?limit=${limit}`),

  // summon
  summon: (bannerId, count) => request('/api/summon', { method: 'POST', body: { bannerId, count } }),
  summonHistory: () => request('/api/summon/history'),
  rotateSeed: () => request('/api/summon/rotate-seed', { method: 'POST' }),

  // roster
  train: (fighterId, levels = 1) =>
    request('/api/roster/train', { method: 'POST', body: { fighterId, levels } }),
  soulBoost: (fighterId, stat, points = 1) =>
    request('/api/roster/soul-boost', { method: 'POST', body: { fighterId, stat, points } }),

  // teams
  saveTeam: (slotIndex, name, members) =>
    request('/api/teams', { method: 'PUT', body: { slotIndex, name, members } }),

  // battles
  startBattle: (stageId, members) =>
    request('/api/battles', { method: 'POST', body: { stageId, members } }),
  getBattle: (id) => request(`/api/battles/${id}`),
  battleAction: (id, action) => request(`/api/battles/${id}/action`, { method: 'POST', body: action }),
  forfeit: (id) => request(`/api/battles/${id}/forfeit`, { method: 'POST' }),

  // missions
  claimMission: (missionId) => request('/api/missions/claim', { method: 'POST', body: { missionId } }),
};
