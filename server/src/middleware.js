import crypto from "node:crypto";

export function ensureCsrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  res.locals.csrfToken = req.session.csrf;
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function csrfValid(req) {
  // A multipart body can carry an old field while the header carries the
  // token fetched for the current session (or the other way around). Accept
  // any candidate that matches, instead of letting one stale value win.
  const candidates = [req.get("x-csrf-token"), req.body?._csrf, req.query?._csrf]
    .map((value) => (value == null ? "" : String(value)))
    .filter(Boolean);
  return candidates.some((token) => safeEqual(token, req.session.csrf));
}

export function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Multipart bodies are still unparsed at this layer. Only the routes that
  // parse the file themselves continue; they call csrfValid() before writing.
  if (req.is("multipart/form-data")) {
    // A header token is readable before the body is parsed, so a valid one
    // lets the request through even when the multipart path or proxy prefix
    // is unexpected. The route still validates it again after parsing.
    if (req.get("x-csrf-token") && csrfValid(req)) return next();
    const multipartRoutes = [
      /\/imports\/upload\/?$/,
      /\/instances\/?$/,
      /\/instances\/\d+\/?$/,
      /\/instances\/\d+\/import\/upload\/?$/,
      /\/users\/?$/,
      /\/users\/\d+\/edit\/?$/,
      /\/settings\/account\/?$/,
    ];
    if (multipartRoutes.some((pattern) => pattern.test(req.path))) return next();
    console.warn("[csrf-multipart]", {
      method: req.method,
      path: req.path,
      user: req.session?.user?.email || null,
      hasSessionToken: Boolean(req.session?.csrf),
      hasBodyToken: Boolean(req.body?._csrf),
      hasHeaderToken: Boolean(req.get("x-csrf-token")),
    });
    return res.status(403).render("pages/403.njk", {
      page: "", title: "Request expired",
      message: "Your form session expired. Reload the page and try again.",
    });
  }
  if (!csrfValid(req)) {
    console.warn("[csrf]", {
      method: req.method,
      path: req.path,
      user: req.session?.user?.email || null,
      hasSessionToken: Boolean(req.session?.csrf),
      hasBodyToken: Boolean(req.body?._csrf),
      hasHeaderToken: Boolean(req.get("x-csrf-token")),
    });
    return res.status(403).render("pages/403.njk", {
      page: "",
      title: "Request expired",
      message: "Your form session expired. Reload the page and try again.",
    });
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.session.user) return next();
  const target = req.originalUrl && req.method === "GET" ? req.originalUrl : "/";
  return res.redirect(`/login?next=${encodeURIComponent(target)}`);
}

export function requireAdmin(req, res, next) {
  if (req.session.user?.role === "admin") return next();
  return res.status(403).render("pages/403.njk", {
    page: "",
    title: "Admins only",
    message: "This page is only available to the instance owner.",
  });
}

export function flash(req, type, message) {
  req.session.flash = { type, message };
}

export function exposeFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  next();
}

// Simple in-memory login brake. Good enough for a self-hosted single instance.
const attempts = new Map();
export function loginAllowed(key) {
  const entry = attempts.get(key);
  if (!entry) return true;
  if (Date.now() - entry.first > 15 * 60_000) {
    attempts.delete(key);
    return true;
  }
  return entry.count < 8;
}
export function noteLoginFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > 15 * 60_000) attempts.set(key, { count: 1, first: now });
  else entry.count += 1;
}
export function clearLoginFailures(key) {
  attempts.delete(key);
}
