import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Stub JWT authentication middleware for MVP.
 * Accepts a fixed token "dev-token" for local development.
 * In production, this would verify real JWT tokens.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return reply.status(401).send({ error: 'Missing Authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');

  // MVP stub: accept "dev-token" as valid
  if (token === 'dev-token') {
    (request as FastifyRequest & { userId: string }).userId = 'dev-user-id';
    return;
  }

  return reply.status(401).send({ error: 'Invalid token. Use "dev-token" for development.' });
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}
