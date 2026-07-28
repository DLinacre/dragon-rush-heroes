'use strict';
/**
 * HTTP route table.
 *
 * Conventions
 * -----------
 * - Everything is namespaced under `/api`.
 * - Mutating routes require an authenticated session and a valid CSRF token
 *   (enforced globally in middleware).
 * - Handlers are thin: they validate the shape of the request and delegate to
 *   a service. All business rules live in `server/services` and `server/domain`.
 * - Responses use a consistent envelope: `{ data }` on success,
 *   `{ error: { code, message, details } }` on failure.
 */

const config = require('../config');
const { requireAuth, rateLimit } = require('../middleware');
const { notFound } = require('../core/errors');
const { serverSeedHash } = require('../core/crypto');

/**
 * Wire all routes onto the application.
 * @param {import('../core/http').Application} app
 * @param {object} deps `{ authService, gameService, repos }`
 */
function registerRoutes(app, { authService, gameService, repos }) {
  const authLimit = rateLimit('auth', config.rateLimit.authPerMinute);
  const actionLimit = rateLimit('action', config.rateLimit.actionPerMinute);

  /** Standard success envelope. */
  const ok = (res, data, status = 200) => res.status(status).json({ data });

  // ------------------------------------------------------------- system ---

  /** Liveness/readiness probe for orchestrators. */
  app.get('/api/health', (req, res) => {
    ok(res, {
      status: 'healthy',
      env: config.env,
      uptime: Math.round(process.uptime()),
      version: require('../../package.json').version,
      collections: {
        users: repos.users.size,
        players: repos.players.size,
        roster: repos.roster.size,
        battles: repos.battles.size,
      },
    });
  });

  /**
   * Static game data. Cached hard by the client — it only changes on deploy.
   */
  app.get('/api/catalogue', (req, res) => {
    res.header('Cache-Control', 'public, max-age=600, must-revalidate');
    ok(res, gameService.getCatalogue());
  });

  /** Publish the provably-fair commitment so players can audit summons. */
  app.get('/api/fairness', (req, res) => {
    ok(res, {
      serverSeedHash: serverSeedHash(),
      algorithm: 'HMAC-SHA512(serverSeed, `${clientSeed}:${nonce}:${cursor}`)',
      note:
        'The server seed hash is published in advance. After a seed rotation the ' +
        'raw seed is revealed so every historic summon can be recomputed and verified.',
    });
  });

  // --------------------------------------------------------------- auth ---

  app.post('/api/auth/register', authLimit, async (req, res) => {
    const result = await authService.register(req.body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.cookie(config.security.cookieName, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: result.maxAge,
    });
    res.cookie(config.security.csrfCookieName, result.csrfToken, {
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: result.maxAge,
    });
    ok(res, { user: result.user, player: result.player, csrfToken: result.csrfToken }, 201);
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    const result = await authService.login(req.body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.cookie(config.security.cookieName, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: result.maxAge,
    });
    res.cookie(config.security.csrfCookieName, result.csrfToken, {
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: result.maxAge,
    });
    ok(res, { user: result.user, player: result.player, csrfToken: result.csrfToken });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.session) await authService.logout(req.session.id);
    res.clearCookie(config.security.cookieName);
    res.clearCookie(config.security.csrfCookieName, { httpOnly: false });
    ok(res, { loggedOut: true });
  });

  /** Who am I? Used by the client to restore a session on page load. */
  app.get('/api/auth/session', (req, res) => {
    if (!req.session || !req.user) return ok(res, { authenticated: false });
    ok(res, {
      authenticated: true,
      user: { id: req.user.id, email: req.user.email, createdAt: req.user.createdAt },
    });
  });

  app.post('/api/auth/password', requireAuth, authLimit, async (req, res) => {
    const result = await authService.changePassword(req.user.id, req.body, req.session.id);
    ok(res, result);
  });

  // ------------------------------------------------------------- player ---

  app.get('/api/player', requireAuth, (req, res) => {
    ok(res, gameService.getPlayerState(req.user.id));
  });

  app.patch('/api/player/profile', requireAuth, async (req, res) => {
    ok(res, await gameService.updateProfile(req.user.id, req.body));
  });

  app.patch('/api/player/settings', requireAuth, async (req, res) => {
    ok(res, await gameService.updateSettings(req.user.id, req.body));
  });

  /** GDPR data portability. */
  app.get('/api/player/export', requireAuth, (req, res) => {
    res.header('Content-Disposition', 'attachment; filename="dragonball-heroes-export.json"');
    ok(res, gameService.exportData(req.user.id));
  });

  /** GDPR right to erasure. Irreversible. */
  app.delete('/api/player', requireAuth, async (req, res) => {
    await authService.deleteAccount(req.user.id);
    res.clearCookie(config.security.cookieName);
    res.clearCookie(config.security.csrfCookieName, { httpOnly: false });
    ok(res, { deleted: true });
  });

  app.get('/api/player/ledger', requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? '50', 10) || 50));
    ok(res, { entries: repos.listLedger(req.user.id, limit) });
  });

  // ------------------------------------------------------------- summon ---

  app.post('/api/summon', requireAuth, actionLimit, async (req, res) => {
    ok(res, await gameService.summon(req.user.id, req.body));
  });

  app.get('/api/summon/history', requireAuth, (req, res) => {
    ok(res, { entries: repos.listSummons(req.user.id, 30) });
  });

  app.post('/api/summon/rotate-seed', requireAuth, async (req, res) => {
    ok(res, await gameService.rotateClientSeed(req.user.id));
  });

  // ------------------------------------------------------------- roster ---

  app.post('/api/roster/train', requireAuth, actionLimit, async (req, res) => {
    ok(res, await gameService.trainFighter(req.user.id, req.body));
  });

  app.post('/api/roster/soul-boost', requireAuth, actionLimit, async (req, res) => {
    ok(res, await gameService.soulBoost(req.user.id, req.body));
  });

  // -------------------------------------------------------------- teams ---

  app.put('/api/teams', requireAuth, async (req, res) => {
    ok(res, await gameService.saveTeam(req.user.id, req.body));
  });

  // ------------------------------------------------------------ battles ---

  app.post('/api/battles', requireAuth, actionLimit, async (req, res) => {
    ok(res, await gameService.startBattle(req.user.id, req.body), 201);
  });

  app.get('/api/battles/:id', requireAuth, (req, res) => {
    ok(res, gameService.getBattle(req.user.id, req.params.id));
  });

  app.post('/api/battles/:id/action', requireAuth, actionLimit, async (req, res) => {
    ok(res, await gameService.battleAction(req.user.id, req.params.id, req.body));
  });

  app.post('/api/battles/:id/forfeit', requireAuth, async (req, res) => {
    ok(res, await gameService.forfeitBattle(req.user.id, req.params.id));
  });

  // ----------------------------------------------------------- missions ---

  app.post('/api/missions/claim', requireAuth, async (req, res) => {
    ok(res, await gameService.claimMission(req.user.id, req.body));
  });

  // ------------------------------------------------------------ fallback --

  // Unknown /api/* paths must 404 as JSON rather than falling through to the
  // SPA shell, which would confuse clients with an HTML body.
  app.get('/api/:rest', () => { throw notFound('Unknown API endpoint.'); });
  app.post('/api/:rest', () => { throw notFound('Unknown API endpoint.'); });
}

module.exports = { registerRoutes };
