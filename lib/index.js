const SCRIPT = `
  local current = tonumber(redis.call("incr", KEYS[1]))
  if current == 1 then
    redis.call("expire", KEYS[1], ARGV[1])
  end
  local ttl = redis.call("ttl", KEYS[1])
  return {current, ttl}
`;

let sha;

exports.register = (server, options, next) => {
  /**
   * onPreStart
   */
  server.ext('onPreStart', (extServer, extNext) => {
    return options.redisClient.scriptAsync('LOAD', SCRIPT)
      .then((returnSha) => {
        sha = returnSha;
        extNext();
      });
  });

  /**
   * onPostAuth
   */
  server.ext('onPostAuth', (request, reply) => {
    request.plugins['hapi-rate-limiter'] = { rate: null };

    // only GET / POST / DELETE
    if (!(request.route.method === 'get' || request.route.method === 'post' || request.route.method === 'delete')) {
      return reply.continue();
    }

    // check enabled
    const enabledForAll = options.hasOwnProperty('enabledForAll') ? options.enabledForAll : false;
    const routeSettings = request.route.settings.plugins.rateLimit || {};
    routeSettings.enabled = routeSettings.hasOwnProperty('enabled') ? routeSettings.enabled : enabledForAll;

    if (!routeSettings || !routeSettings.enabled) {
      return reply.continue();
    }

    // check custom options
    const rate = Object.assign({}, options.defaultRate(request));
    if (routeSettings.limit) {
      rate.limit = routeSettings.limit;
    }
    if (routeSettings.window) {
      rate.window = routeSettings.window;
    }

    // prepare redis key
    const defaultRateLimitPrefix = (req) => `${req.route.method}:${req.route.path}`;
    const rateLimitKeyPrefix = options.rateLimitKeyPrefix || defaultRateLimitPrefix;
    const rateLimitKey = options.rateLimitKey;
    const key = `hapi-rate-limiter:${rateLimitKeyPrefix(request)}:${rateLimitKey(request)}`;

    // exec
    return options.redisClient.evalshaAsync(sha, 1, key, rate.window)
      .spread((count, ttl) => {
        const remaining = rate.limit - count;

        rate.remaining = Math.max(remaining, 0);
        rate.reset = Math.floor(new Date().getTime() / 1000) + ttl;
        request.plugins['hapi-rate-limiter'].rate = rate;

        if (remaining < 0) {
          const msg = options.overLimitError(rate);
          return reply({ error: msg }).code(429);
        }

        return reply.continue();
      });

  });

  /**
   * onPreResponse
   */
  server.ext('onPreResponse', (request, reply) => {
    const rate = request.plugins['hapi-rate-limiter'] ? request.plugins['hapi-rate-limiter'].rate : null;

    if (options.headers && rate) {
      // if an error was thrown, set headers on error-response instead
      const headers = request.response.output ? request.response.output.headers : request.response.headers;

      headers['X-Rate-Limit-Remaining'] = rate.remaining;
      headers['X-Rate-Limit-Limit'] = rate.limit;
      headers['X-Rate-Limit-Reset'] = rate.reset;
    }

    return reply.continue();
  });

  // end
  next();
};

exports.register.attributes = {
  name: 'hapi-rate-limiter'
};
