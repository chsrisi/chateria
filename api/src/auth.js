import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;

if (!secret) {
  throw new Error('JWT_SECRET is required');
}

export function createToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    secret,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );
}

export function verifyToken(token) {
  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  const id = Number(payload.sub);
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid token subject');
  return { id, username: payload.username };
}

export function authRequired(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = verifyToken(match[1]);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
